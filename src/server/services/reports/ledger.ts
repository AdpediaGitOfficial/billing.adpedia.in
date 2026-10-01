import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import type { AccountType } from '@prisma/client'

export interface Period { from: Date; to: Date }

export interface AccountBalance {
  accountId: string
  code: string
  name: string
  type: AccountType
  subType: string | null
  parentCode: string | null
  /** balance carried INTO the period, signed in the account's natural direction */
  opening: Decimal
  /** movement WITHIN the period */
  debit: Decimal
  credit: Decimal
  /** opening + movement, signed naturally */
  closing: Decimal
}

/** Assets and expenses are debit-natured; liabilities, equity and income are credit-natured. */
export function isDebitNatured(type: AccountType): boolean {
  return type === 'ASSET' || type === 'EXPENSE'
}

/** Signed in the account's own direction, so a healthy balance is always positive. */
export function naturalBalance(type: AccountType, debit: Decimal, credit: Decimal): Decimal {
  return isDebitNatured(type) ? debit.minus(credit) : credit.minus(debit)
}

/**
 * 🔴 The one query every report in this phase is built on.
 *
 * Reports do NOT read invoices, bills or payroll — they read JOURNAL LINES. That is the
 * whole point of posting everything through `postJournal`: there is exactly one set of
 * numbers, and a figure on the P&L is the same figure the trial balance sees. A report
 * that re-derived revenue from the invoice table could disagree with the ledger, and then
 * neither number would be trustworthy.
 *
 * `opening` is every movement strictly BEFORE `from`, which is what makes a balance sheet
 * at a date possible without a closing process.
 */
export async function accountBalances(
  ctx: RequestContext,
  period: Period,
  opts: { includeZero?: boolean } = {},
): Promise<AccountBalance[]> {
  assertCan(ctx.role, 'reports', 'read')

  const accounts = await prisma.account.findMany({
    where: { companyId: ctx.companyId },
    include: { parent: { select: { code: true } } },
    orderBy: { code: 'asc' },
  })

  const [openingRows, periodRows] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { journalEntry: { companyId: ctx.companyId, date: { lt: period.from } } },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } } },
      _sum: { debit: true, credit: true },
    }),
  ])

  const openingBy = new Map(openingRows.map((r) => [r.accountId, r]))
  const periodBy = new Map(periodRows.map((r) => [r.accountId, r]))

  const out: AccountBalance[] = accounts.map((a) => {
    const o = openingBy.get(a.id)
    const p = periodBy.get(a.id)
    const oDr = new Decimal(o?._sum.debit?.toString() ?? '0')
    const oCr = new Decimal(o?._sum.credit?.toString() ?? '0')
    const debit = new Decimal(p?._sum.debit?.toString() ?? '0')
    const credit = new Decimal(p?._sum.credit?.toString() ?? '0')
    const opening = naturalBalance(a.type, oDr, oCr)
    return {
      accountId: a.id, code: a.code, name: a.name, type: a.type, subType: a.subType,
      parentCode: a.parent?.code ?? null,
      opening, debit, credit,
      closing: opening.plus(naturalBalance(a.type, debit, credit)),
    }
  })

  if (opts.includeZero) return out
  return out.filter((b) => !b.opening.isZero() || !b.debit.isZero() || !b.credit.isZero())
}

export interface LedgerLine {
  id: string
  date: Date
  entryNo: number
  entryId: string
  narration: string
  lineNarration: string | null
  sourceType: string
  sourceId: string | null
  debit: Decimal
  credit: Decimal
  /** running balance in the account's natural direction */
  balance: Decimal
}

/**
 * The drill-through. Every figure on every report in this phase resolves to this list —
 * that is the difference between a report you can sign and a number on a screen.
 */
export async function accountLedger(
  ctx: RequestContext,
  accountCode: string,
  period: Period,
): Promise<{ account: AccountBalance; lines: LedgerLine[] } | null> {
  assertCan(ctx.role, 'reports', 'read')

  const account = await prisma.account.findUnique({
    where: { companyId_code: { companyId: ctx.companyId, code: accountCode } },
    include: { parent: { select: { code: true } } },
  })
  if (!account) return null

  const [openingAgg, rows] = await Promise.all([
    prisma.journalLine.aggregate({
      where: { accountId: account.id, journalEntry: { companyId: ctx.companyId, date: { lt: period.from } } },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.findMany({
      where: { accountId: account.id, journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } } },
      include: { journalEntry: { select: { id: true, entryNo: true, date: true, narration: true, sourceType: true, sourceId: true } } },
      orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntry: { entryNo: 'asc' } }],
    }),
  ])

  const opening = naturalBalance(
    account.type,
    new Decimal(openingAgg._sum.debit?.toString() ?? '0'),
    new Decimal(openingAgg._sum.credit?.toString() ?? '0'),
  )

  let running = opening
  let periodDr = ZERO
  let periodCr = ZERO
  const lines: LedgerLine[] = rows.map((l) => {
    const debit = new Decimal(l.debit.toString())
    const credit = new Decimal(l.credit.toString())
    periodDr = periodDr.plus(debit)
    periodCr = periodCr.plus(credit)
    running = running.plus(naturalBalance(account.type, debit, credit))
    return {
      id: l.id, date: l.journalEntry.date, entryNo: l.journalEntry.entryNo, entryId: l.journalEntry.id,
      narration: l.journalEntry.narration, lineNarration: l.narration,
      sourceType: l.journalEntry.sourceType, sourceId: l.journalEntry.sourceId,
      debit, credit, balance: running,
    }
  })

  return {
    account: {
      accountId: account.id, code: account.code, name: account.name, type: account.type,
      subType: account.subType, parentCode: account.parent?.code ?? null,
      opening, debit: periodDr, credit: periodCr, closing: running,
    },
    lines,
  }
}
