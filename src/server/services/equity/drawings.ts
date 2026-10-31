import type { Constitution, DrawingPurpose, MoneySource, OwnerMovementKind } from '@prisma/client'
import { prisma } from '@/server/db'
import { Decimal, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import type { Period } from '@/server/services/reports/ledger'
import { balanceSheet } from '@/server/services/reports/statements'

/**
 * Drawings — docs/82 §4, and the reason the chart has an equity contra at all.
 *
 * 🔴 **A complete record is not the same as a deductible one.** A proprietor and their
 * proprietorship are one person for income tax, so money moves between them constantly: rent
 * from the business account, groceries, a medical bill, a transfer to savings. All of it has
 * to be recorded — a bank statement with unexplained debits is not a set of books — and none
 * of it may touch the profit the proprietor declares.
 *
 * That is exactly what an equity contra does. `profitAndLoss` reads INCOME and EXPENSE, so
 * `3300 Drawings` cannot reach it however much goes through. Booked as an expense instead,
 * household spending would understate the declared profit by its whole value, which is the one
 * line between a complete record and a wrong return — and s.37(1)'s "wholly and exclusively"
 * is the provision that would be cited when it was noticed.
 *
 * What IS deductible, some of this, is deductible in the owner's PERSONAL return and not here:
 * rent against the HRA in a salary (s.10(13A)), medical insurance under s.80D, 80C
 * investments. Hence the purpose: the personal return is prepared from a complete record, and
 * nothing is claimed in these books.
 */

export const DRAWINGS = '3300'
export const OWNER_CAPITAL = '3000'
export const CASH_IN_HAND = '1050'

export interface PurposeMeta {
  value: DrawingPurpose
  label: string
  /** where, if anywhere, this is deductible — and it is never here */
  note: string
}

/** 🔴 Ordered by what a household actually spends, not alphabetically. */
export const DRAWING_PURPOSES: readonly PurposeMeta[] = [
  { value: 'RENT', label: 'Rent',
    note: 'Claimed against the HRA in a salary, in the personal return — s.10(13A). Not an expense of this business.' },
  { value: 'HOUSEHOLD', label: 'Household & groceries',
    note: 'Deductible nowhere. Recorded so the bank statement reconciles.' },
  { value: 'MEDICAL', label: 'Medical',
    note: 'Insurance premiums go to s.80D in the personal return; treatment generally nowhere.' },
  { value: 'EDUCATION', label: 'Education & fees',
    note: 'Tuition fees are an 80C item in the personal return.' },
  { value: 'INSURANCE_INVESTMENT', label: 'Insurance & investments',
    note: 'LIC, PPF, ELSS — 80C in the personal return. Taking money out to invest it is still a drawing.' },
  { value: 'PERSONAL_TAX', label: 'Own income tax',
    note: 'The owner’s advance tax or self-assessment. Never the business’s expense, even when it is paid from the business account.' },
  { value: 'TRANSFER', label: 'Transfer to a personal account',
    note: 'Moved out with nothing else said about it.' },
  { value: 'OTHER', label: 'Something else',
    note: 'Say what it was in the note — a drawing nobody can explain in March is the one that gets asked about.' },
]

export const purposeLabel = (p: DrawingPurpose | null): string =>
  DRAWING_PURPOSES.find((x) => x.value === p)?.label ?? '—'

/**
 * 🔴 Which constitutions HAVE drawings — the same question `equityRows` answers for the chart.
 *
 * A company is a separate legal person from its shareholders, so there is no such thing as
 * taking money out of it informally. What looks like a drawing is one of three different
 * transactions with three different tax consequences, and the difference is not cosmetic.
 */
export function hasDrawings(constitution: Constitution): boolean {
  return constitution === 'PROPRIETORSHIP' || constitution === 'PARTNERSHIP' || constitution === 'LLP'
}

async function ownerContext(companyId: string) {
  return prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { legalName: true, constitution: true },
  })
}

export async function assertHasDrawings(companyId: string, what: string): Promise<void> {
  const co = await ownerContext(companyId)
  if (hasDrawings(co.constitution)) return

  throw new AppError(
    `${co.legalName} is a company, and a company has no drawings. ${what} is not available to `
    + 'it. Money a director takes out is one of three things, each with its own consequence: '
    + 'remuneration, which is salary in their hands and carries TDS under s.192; a dividend, '
    + 'which is a distribution of already-taxed profit; or a loan through 2500 Director’s '
    + 'Current Account, which s.185 limits and which has to be repaid. Pick the one that '
    + 'happened — they are not three labels for the same transfer.',
    409,
    'NO_DRAWINGS',
  )
}

export interface OwnerMovementInput {
  kind: OwnerMovementKind
  date: string
  amount: string
  purpose?: DrawingPurpose | null
  source?: MoneySource
  bankAccountId?: string | null
  narration: string
}

/**
 * Record money out to, or in from, the owner — and post it.
 *
 * 🔴 There is no cancel. A drawing entered wrongly is corrected by a CAPITAL movement for the
 * same amount, which is what actually happened if the money went back, and an honest
 * correction if it did not. The pair reads as a history; a deletion reads as nothing at all,
 * and the database refuses it anyway.
 */
export async function recordOwnerMovement(ctx: RequestContext, input: OwnerMovementInput) {
  assertCan(ctx.role, 'journal', 'write')
  await assertHasDrawings(ctx.companyId, input.kind === 'DRAWING' ? 'Recording a drawing' : 'Introducing capital')

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')
  const fy = await assertPostable(ctx.companyId, date)

  const amount = round2(new Decimal((input.amount || '0').replace(/,/g, '')))
  if (!amount.isFinite() || amount.lte(0)) throw new AppError('A drawing needs a positive amount')

  const narration = input.narration.trim()
  if (narration.length < 3) {
    throw new AppError('Say what the money was for — a drawing nobody can explain in March is the one that gets asked about')
  }

  /**
   * 🔴 The purpose is required on a DRAWING and refused on a CAPITAL.
   *
   * It is the only field that makes the record useful at the other end: the personal return is
   * prepared from it, and "₹85,000 taken out" with no purpose cannot tell anyone whether the
   * rent in it is claimable against HRA. Capital coming in has no purpose beyond funding the
   * business, and offering one would invite a story about money that needs none.
   */
  if (input.kind === 'DRAWING' && !input.purpose) {
    throw new AppError('Pick what the money was for — it is what makes the record usable in the personal return')
  }
  if (input.kind === 'CAPITAL' && input.purpose) {
    throw new AppError('Capital coming in has no purpose to record — it is funding the business')
  }

  const source: MoneySource = input.source ?? 'BANK'
  let bankAccountId: string | null = null
  let moneyCode = CASH_IN_HAND

  if (source === 'BANK') {
    // 🔴 scoped: a bank account id arrives from a form, so it is a request, not a fact
    const bank = input.bankAccountId
      ? await prisma.companyBankAccount.findFirst({
          where: { id: input.bankAccountId, companyId: ctx.companyId },
          include: { ledgerAccount: true },
        })
      : await prisma.companyBankAccount.findFirst({
          where: { companyId: ctx.companyId, isDefault: true },
          include: { ledgerAccount: true },
        })
    if (input.bankAccountId && !bank) throw new AppError('That bank account does not belong to this entity')
    bankAccountId = bank?.id ?? null
    moneyCode = bank?.ledgerAccount?.code ?? '1010'
  }

  const movement = await prisma.ownerMovement.create({
    data: {
      companyId: ctx.companyId, financialYearId: fy.id,
      kind: input.kind, purpose: input.kind === 'DRAWING' ? input.purpose! : null,
      date, amount: amount.toFixed(2), source, bankAccountId,
      narration, createdById: ctx.userId,
    },
  })

  await postJournal(ctx, {
    date,
    narration: input.kind === 'DRAWING' ? `Drawings — ${narration}` : `Capital introduced — ${narration}`,
    sourceType: 'OWNER_MOVEMENT',
    sourceId: movement.id,
    postings: input.kind === 'DRAWING'
      // 🔴 EQUITY on the debit side. Nothing here is an expense, and that is the whole design.
      ? [{ accountCode: DRAWINGS, debit: amount, narration }, { accountCode: moneyCode, credit: amount }]
      : [{ accountCode: moneyCode, debit: amount, narration }, { accountCode: OWNER_CAPITAL, credit: amount }],
  })

  await audit(ctx, {
    entity: 'OwnerMovement', entityId: movement.id, action: 'CREATE',
    after: { kind: input.kind, amount: amount.toFixed(2), purpose: movement.purpose },
  })
  return movement
}

export interface DrawingsSummary {
  drawn: Decimal
  introduced: Decimal
  /** 🔴 what the owner has actually taken out of the business, net of what they put in */
  net: Decimal
  byPurpose: { purpose: DrawingPurpose; label: string; total: Decimal }[]
  /** 🔴 the equity total the BALANCE SHEET reports, not a second computation of it */
  ownerFunds: Decimal
  movements: Awaited<ReturnType<typeof listOwnerMovements>>
}

export async function listOwnerMovements(ctx: RequestContext, limit = 200) {
  assertCan(ctx.role, 'journal', 'read')
  return prisma.ownerMovement.findMany({
    where: { companyId: ctx.companyId },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })
}

/**
 * What has moved, and where it leaves the owner's stake.
 *
 * 🔴 `ownerFunds` can legitimately go NEGATIVE, and that is information rather than an error.
 * A proprietor taking out more than the business has earned is not doing anything unlawful —
 * unlike a company paying a dividend it has not got — but it means the business is being
 * funded by its creditors, and the capital account is the only place that shows it.
 */
export async function drawingsSummary(ctx: RequestContext, period: Period): Promise<DrawingsSummary> {
  assertCan(ctx.role, 'journal', 'read')
  await assertHasDrawings(ctx.companyId, 'The drawings register')

  const [rows, grouped, bs, movements] = await Promise.all([
    prisma.ownerMovement.groupBy({
      by: ['kind'],
      where: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } },
      _sum: { amount: true },
    }),
    prisma.ownerMovement.groupBy({
      by: ['purpose'],
      where: { companyId: ctx.companyId, kind: 'DRAWING', date: { gte: period.from, lte: period.to } },
      _sum: { amount: true },
    }),
    /**
     * 🔴 Asked of the balance sheet rather than computed here, and that is deliberate.
     *
     * Summing the EQUITY accounts gets the wrong answer for eleven months of the year: this
     * year's profit is still sitting in income and expense accounts, because `3200 Current
     * Year Profit` is only written by the year-end close. The balance sheet already derives
     * it — `statements.ts` adds a current-year line and a prior-years-not-yet-closed line —
     * so taking its total is the only way this figure cannot disagree with the statement
     * somebody will check it against.
     */
    balanceSheet(ctx, period.to, period.from),
    listOwnerMovements(ctx),
  ])

  const sum = (kind: OwnerMovementKind) =>
    new Decimal(rows.find((r) => r.kind === kind)?._sum.amount?.toString() ?? '0')
  const drawn = sum('DRAWING')
  const introduced = sum('CAPITAL')

  const byPurpose = grouped
    .filter((g): g is typeof g & { purpose: DrawingPurpose } => g.purpose !== null)
    .map((g) => ({
      purpose: g.purpose,
      label: purposeLabel(g.purpose),
      total: new Decimal(g._sum.amount?.toString() ?? '0'),
    }))
    .sort((a, b) => b.total.comparedTo(a.total))

  return { drawn, introduced, net: drawn.minus(introduced), byPurpose, ownerFunds: bs.equity.total, movements }
}
