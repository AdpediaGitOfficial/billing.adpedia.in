import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { SWIFT_RE } from './profile'

/**
 * Giving an entity somewhere for money to arrive — docs/88.
 *
 * 🔴 Nothing in the application could create a `CompanyBankAccount`. The seed did, for the
 * first company, and `createCompany` makes only the ledger account a bank would map to. So
 * the second entity had no bank account at all, and two things followed that nobody had seen,
 * because every test and every screen ran as the company the seed built:
 *
 * - its invoices printed **—** under Payment details, so a client had nowhere to pay;
 * - `createReceipt` looks the default account up with `findFirstOrThrow`, so **recording the
 *   money when it did arrive threw**, as a database "not found" and not as a sentence.
 *
 * Found by looking at a personal account's invoice as the client would receive it.
 */

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const ACCOUNT_NO_RE = /^[A-Z0-9][A-Z0-9 -]{3,32}[A-Z0-9]$/
const UPI_RE = /^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/

export interface BankAccountInput {
  /** what it is called in this system and in the ledger — "HDFC — Savings" */
  label: string
  bankName: string
  branch?: string
  /** the name the account is held in; defaults to the entity's legal name */
  accountName?: string
  accountNo: string
  /** optional: an overseas account has none */
  ifsc?: string
  swift?: string
  upiId?: string
  /** print it on invoices. The first account always does. */
  showOnInvoice?: boolean
  makeDefault?: boolean
}

export async function addBankAccount(ctx: RequestContext, input: BankAccountInput) {
  assertCan(ctx.role, 'settings.company', 'write')

  const label = input.label.trim()
  const bankName = input.bankName.trim()
  if (label.length < 2) throw new AppError('Give the account a name — it is how it is listed, e.g. “HDFC — Savings”')
  if (bankName.length < 2) throw new AppError('Which bank is it with?')

  const accountNo = input.accountNo.trim().toUpperCase()
  if (!ACCOUNT_NO_RE.test(accountNo)) {
    throw new AppError('That does not look like an account number — digits, as printed on the passbook or cheque')
  }
  const ifsc = input.ifsc?.trim().toUpperCase() || null
  if (ifsc && !IFSC_RE.test(ifsc)) {
    throw new AppError(`"${input.ifsc?.trim()}" is not an IFSC — four letters, a zero, then six characters, as on the cheque book`)
  }
  const swift = input.swift?.trim().toUpperCase().replace(/\s+/g, '') || null
  if (swift && !SWIFT_RE.test(swift)) {
    throw new AppError(`"${input.swift?.trim()}" is not a SWIFT code — eight characters for the bank, or eleven with the branch`)
  }
  const upiId = input.upiId?.trim() || null
  if (upiId && !UPI_RE.test(upiId)) throw new AppError(`"${upiId}" is not a UPI ID — it looks like name@bank`)

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { legalName: true },
  })

  const account = await prisma.$transaction(async (tx) => {
    const existing = await tx.companyBankAccount.findMany({
      where: { companyId: ctx.companyId }, select: { id: true, accountNo: true, ledgerAccountId: true },
    })
    if (existing.some((b) => b.accountNo === accountNo)) {
      throw new AppError('That account number is already on file for this entity')
    }
    const first = existing.length === 0

    /**
     * 🔴 Each bank account is its own ledger account, so a bank statement reconciles against
     * one balance and not a blend. The first account takes the 1010 the chart was created with;
     * later ones get 1011, 1012… under 1000 Bank Accounts, below 1050 Cash in Hand.
     */
    const parent = await tx.account.findUniqueOrThrow({
      where: { companyId_code: { companyId: ctx.companyId, code: '1000' } },
    })
    const gl1010 = await tx.account.findUniqueOrThrow({
      where: { companyId_code: { companyId: ctx.companyId, code: '1010' } },
    })
    const gl1010Taken = existing.some((b) => b.ledgerAccountId === gl1010.id)

    let ledgerAccountId: string
    if (!gl1010Taken) {
      await tx.account.update({ where: { id: gl1010.id }, data: { name: label } })
      ledgerAccountId = gl1010.id
    } else {
      const used = new Set((await tx.account.findMany({
        where: { companyId: ctx.companyId, parentId: parent.id }, select: { code: true },
      })).map((a) => a.code))
      let code = 1011
      while (used.has(String(code)) && code < 1050) code++
      if (code >= 1050) throw new AppError('There is no room for another bank account in the chart — 1050 is Cash in Hand')
      ledgerAccountId = (await tx.account.create({
        data: {
          companyId: ctx.companyId, code: String(code), name: label, type: 'ASSET',
          subType: 'BANK', parentId: parent.id, isSystem: false,
        },
      })).id
    }

    const asDefault = first || !!input.makeDefault
    const onInvoice = first || !!input.showOnInvoice
    // one of each: the receipt screen reads the default, and the renderer takes ONE account to print
    if (asDefault) await tx.companyBankAccount.updateMany({ where: { companyId: ctx.companyId }, data: { isDefault: false } })
    if (onInvoice) await tx.companyBankAccount.updateMany({ where: { companyId: ctx.companyId }, data: { showOnInvoice: false } })

    return tx.companyBankAccount.create({
      data: {
        companyId: ctx.companyId, label, bankName,
        branch: input.branch?.trim() || null,
        accountName: input.accountName?.trim() || company.legalName,
        accountNo, ifsc, swift, upiId,
        currency: 'INR', ledgerAccountId,
        isDefault: asDefault, showOnInvoice: onInvoice,
      },
    })
  })

  await audit(ctx, {
    entity: 'CompanyBankAccount', entityId: account.id, action: 'CREATE',
    after: { label: account.label, bankName: account.bankName, ifsc: account.ifsc, swift: account.swift },
  })
  return account
}

/**
 * The account money is paid into or out of when the caller did not pick one.
 *
 * 🔴 Four services read this with `findFirstOrThrow`, so an entity with no bank account got a
 * database "no CompanyBankAccount found" as its error — an exception with no sentence in it,
 * for the one thing a person can fix in half a minute.
 */
export async function requireDefaultBank(
  db: Pick<typeof prisma, 'companyBankAccount'>,
  companyId: string,
) {
  const bank = await db.companyBankAccount.findFirst({
    where: { companyId, isDefault: true }, include: { ledgerAccount: true },
  })
  if (!bank) {
    throw new AppError('This entity has no bank account yet. Add one in Settings → Company, then record this again.')
  }
  return bank
}
