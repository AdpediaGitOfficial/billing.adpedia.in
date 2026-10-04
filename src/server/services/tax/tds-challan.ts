import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { tdsPayableAccount } from '@/server/services/accounting/rules/purchase'
import type { Posting } from '@/server/services/accounting/types'

const DAY = 86_400_000

/**
 * Deposit due date: the 7th of the following month, except March which is 30 April.
 * (Rule 30, CGST… no — Rule 30 of the Income-tax Rules.)
 */
export function depositDueDate(deductedOn: Date): Date {
  const y = deductedOn.getUTCFullYear(), m = deductedOn.getUTCMonth() + 1
  if (m === 3) return new Date(Date.UTC(y, 3, 30))
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7))
}

/** Quarterly return due dates: 31 Jul, 31 Oct, 31 Jan, 31 May. */
export function returnDueDate(fyStartYear: number, quarter: 1 | 2 | 3 | 4): Date {
  switch (quarter) {
    case 1: return new Date(Date.UTC(fyStartYear, 6, 31))
    case 2: return new Date(Date.UTC(fyStartYear, 9, 31))
    case 3: return new Date(Date.UTC(fyStartYear + 1, 0, 31))
    case 4: return new Date(Date.UTC(fyStartYear + 1, 4, 31))
  }
}

/** Form 16A / 16 is due within 15 days of the return due date. */
export function certificateDueDate(fyStartYear: number, quarter: 1 | 2 | 3 | 4): Date {
  return new Date(returnDueDate(fyStartYear, quarter).getTime() + 15 * DAY)
}

/** A month or PART of a month — 1 day late is a full month's interest. */
export function monthsOrPart(from: Date, to: Date): number {
  if (to <= from) return 0
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  return to.getUTCDate() > from.getUTCDate() ? months + 1 : Math.max(months, 1)
}

export interface InterestResult {
  notDeducted: Decimal
  notDeposited: Decimal
  total: Decimal
  monthsLate: number
  explanation: string[]
}

/**
 * s.201(1A).
 *   1%   per month or part — from the date the tax was DEDUCTIBLE to the date it was deducted
 *   1.5% per month or part — from the date it was DEDUCTED to the date it was deposited
 *
 * Both are charged on the tax amount, and a single day late costs a whole month.
 */
export function computeInterest(args: {
  tdsAmount: Decimal
  deductibleOn: Date
  deductedOn: Date
  depositedOn: Date
}): InterestResult {
  const { tdsAmount, deductibleOn, deductedOn, depositedOn } = args
  const explanation: string[] = []

  const lateDeductMonths = monthsOrPart(deductibleOn, deductedOn)
  const notDeducted = round2(tdsAmount.mul(1).div(100).mul(lateDeductMonths))
  if (lateDeductMonths > 0) {
    explanation.push(`Deducted ${lateDeductMonths} month${lateDeductMonths === 1 ? '' : 's'} late — 1% a month under s.201(1A)(i)`)
  }

  const due = depositDueDate(deductedOn)
  const lateDepositMonths = depositedOn > due ? monthsOrPart(deductedOn, depositedOn) : 0
  const notDeposited = round2(tdsAmount.mul(1.5).div(100).mul(lateDepositMonths))
  if (lateDepositMonths > 0) {
    explanation.push(`Deposited after ${due.toISOString().slice(0, 10)} — 1.5% a month for ${lateDepositMonths} month${lateDepositMonths === 1 ? '' : 's'} under s.201(1A)(ii)`)
  }

  return {
    notDeducted, notDeposited, total: notDeducted.plus(notDeposited),
    monthsLate: Math.max(lateDeductMonths, lateDepositMonths),
    explanation,
  }
}

/** s.234E: ₹200 a day from the return due date, capped at the TDS in the return. */
export function computeLateFee(args: { tdsInReturn: Decimal; dueOn: Date; filedOn: Date }): { fee: Decimal; days: number; capped: boolean } {
  const days = Math.max(0, Math.floor((args.filedOn.getTime() - args.dueOn.getTime()) / DAY))
  const raw = new Decimal(200).mul(days)
  const capped = raw.gt(args.tdsInReturn)
  return { fee: capped ? args.tdsInReturn : raw, days, capped }
}

/** docs/12 §2.9 — Dr TDS Payable (per section) / Cr Bank, with interest and fee as expense. */
export function postChallan(doc: {
  sectionCode: string; amount: Decimal; interest: Decimal; lateFee: Decimal
  bankAccountCode: string; reference: string
}): Posting[] {
  const postings: Posting[] = [
    { accountCode: tdsPayableAccount(doc.sectionCode), debit: doc.amount, narration: `TDS challan ${doc.reference}` },
  ]
  if (doc.interest.gt(0)) postings.push({ accountCode: '5500', debit: doc.interest, narration: 'Interest u/s 201(1A)' })
  if (doc.lateFee.gt(0)) postings.push({ accountCode: '5500', debit: doc.lateFee, narration: 'Late fee u/s 234E' })
  postings.push({ accountCode: doc.bankAccountCode, credit: doc.amount.plus(doc.interest).plus(doc.lateFee) })
  return postings
}

export interface ChallanInput {
  sectionCode: string
  quarter: number
  deductionIds: string[]
  bsrCode: string
  challanSerial: string
  depositedOn: string
  interest?: string
  lateFee?: string
  cin?: string
  bankAccountId?: string
}

/**
 * The OLTAS challan identification number: the BSR code, then the date of tender as
 * **DDMMYYYY**, then the 5-digit serial — 20 characters, exactly as the counterfoil prints it.
 *
 * 🔴 docs/56 found this constructed as YYYYMMDD. The length came out right, so nothing ever
 * complained — and the 26Q carries the CIN, so every challan in a filed return would have
 * been rejected by TRACES as a challan mismatch and no deductee would have got their credit.
 */
export function oltasCin(bsrCode: string, depositedOn: Date, challanSerial: string): string {
  const d = String(depositedOn.getUTCDate()).padStart(2, '0')
  const m = String(depositedOn.getUTCMonth() + 1).padStart(2, '0')
  return `${bsrCode}${d}${m}${depositedOn.getUTCFullYear()}${challanSerial.padStart(5, '0')}`
}

/** BSR code is 7 digits; the challan serial is 5. Both are printed on the counterfoil. */
export function validateChallanRefs(bsrCode: string, challanSerial: string) {
  if (!/^\d{7}$/.test(bsrCode)) throw new AppError(`BSR code must be 7 digits — "${bsrCode}" is ${bsrCode.length}`)
  if (!/^\d{1,5}$/.test(challanSerial)) throw new AppError(`Challan serial must be up to 5 digits — "${challanSerial}" is not`)
}

export async function createChallan(ctx: RequestContext, input: ChallanInput) {
  assertCan(ctx.role, 'tax', 'write')
  validateChallanRefs(input.bsrCode, input.challanSerial)
  if (input.deductionIds.length === 0) throw new AppError('Select the deductions this challan covers')

  const depositedOn = new Date(input.depositedOn)
  const fy = await assertPostable(ctx.companyId, depositedOn)

  return prisma.$transaction(async (tx) => {
    const deductions = await tx.tdsDeduction.findMany({
      where: { id: { in: input.deductionIds }, companyId: ctx.companyId, challanId: null, reversedAt: null },
    })
    if (deductions.length !== input.deductionIds.length) {
      throw new AppError('Some of those deductions are already on a challan, or have been reversed')
    }
    const wrongSection = deductions.filter((d) => d.sectionCode !== input.sectionCode)
    if (wrongSection.length > 0) {
      throw new AppError(`A challan covers one section. ${wrongSection.length} of the selected deductions are not ${input.sectionCode}.`)
    }

    const amount = deductions.reduce((a, d) => a.plus(d.tdsAmount.toString()), ZERO)
    const interest = round2(new Decimal(input.interest ?? '0'))
    const lateFee = round2(new Decimal(input.lateFee ?? '0'))

    const bank = input.bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({ where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true } })
      : await tx.companyBankAccount.findFirstOrThrow({ where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true } })
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    const challan = await tx.tdsChallan.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, quarter: input.quarter,
        sectionCode: input.sectionCode,
        bsrCode: input.bsrCode, challanSerial: input.challanSerial, depositedOn,
        amount: amount.toFixed(2), interest: interest.toFixed(2), lateFee: lateFee.toFixed(2),
        cin: input.cin ?? oltasCin(input.bsrCode, depositedOn, input.challanSerial),
      },
    })

    await tx.tdsDeduction.updateMany({ where: { id: { in: input.deductionIds } }, data: { challanId: challan.id } })

    await postJournal(ctx, {
      date: depositedOn,
      narration: `TDS challan ${challan.cin} — section ${input.sectionCode}`,
      sourceType: 'TDS_CHALLAN', sourceId: challan.id,
      postings: postChallan({
        sectionCode: input.sectionCode, amount, interest, lateFee,
        bankAccountCode: bank.ledgerAccount.code, reference: challan.cin ?? input.challanSerial,
      }),
    }, tx)

    await audit(ctx, { entity: 'TdsChallan', entityId: challan.id, action: 'CREATE', after: { cin: challan.cin, amount: amount.toFixed(2) } }, tx)
    return challan
  })
}

/** What is owed, by section and by the month it fell due. */
export async function outstandingDeductions(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  const rows = await prisma.tdsDeduction.findMany({
    where: { companyId: ctx.companyId, challanId: null, reversedAt: null },
    include: { vendor: { select: { name: true, pan: true, panVerified: true } }, employee: { select: { name: true, pan: true } } },
    orderBy: [{ sectionCode: 'asc' }, { deductedOn: 'asc' }],
  })

  const today = new Date()
  return rows.map((d) => {
    const due = depositDueDate(d.deductedOn)
    const overdueDays = Math.max(0, Math.floor((today.getTime() - due.getTime()) / DAY))
    const interest = overdueDays > 0
      ? computeInterest({ tdsAmount: new Decimal(d.tdsAmount.toString()), deductibleOn: d.deductedOn, deductedOn: d.deductedOn, depositedOn: today })
      : null
    return {
      id: d.id,
      sectionCode: d.sectionCode,
      quarter: d.quarter,
      deducteeName: d.vendor?.name ?? d.employee?.name ?? 'Unknown',
      deducteePan: d.deducteePan ?? d.vendor?.pan ?? d.employee?.pan ?? null,
      panVerified: d.vendor?.panVerified ?? false,
      deductedOn: d.deductedOn,
      dueOn: due,
      overdueDays,
      baseAmount: new Decimal(d.baseAmount.toString()),
      tdsAmount: new Decimal(d.tdsAmount.toString()),
      interestIfPaidToday: interest?.total ?? ZERO,
      interestNote: interest?.explanation.join(' · ') ?? null,
    }
  })
}
