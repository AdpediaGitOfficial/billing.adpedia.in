import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal, reverseJournal } from './journal'

/**
 * Opening balances — docs/74.
 *
 * 🔴 This is for the FIRST year on the system, and only that. It is not the year-end
 * carry-forward, which is derived and must stay derived — see §1 of the doc, and the refusal
 * below that enforces it.
 *
 * The position at the moment a company starts keeping its books here is the one figure the
 * system genuinely cannot compute: the history is in somebody's spreadsheet. `OPENING_BALANCE`
 * has been in `SourceType` since phase 1 with nothing in the codebase able to write it —
 * `docs/49`'s class, found in an enum this time.
 */

export interface OpeningLine {
  accountCode: string
  debit?: string
  credit?: string
}

export interface OpeningPosition {
  financialYearId: string
  fyLabel: string
  /** the entry currently standing, if any */
  entryId: string | null
  postedOn: Date | null
  lines: { code: string; name: string; type: string; debit: Decimal; credit: Decimal }[]
  totalDebit: Decimal
  totalCredit: Decimal
  /** 🔴 true only for the earliest year — every other year's opening is derived */
  eligible: boolean
  why: string
}

/** The earliest financial year this company has, which is the only one that may carry one. */
async function earliestYear(companyId: string) {
  return prisma.financialYear.findFirst({ where: { companyId }, orderBy: { startsOn: 'asc' } })
}

export async function openingPosition(ctx: RequestContext, financialYearId: string): Promise<OpeningPosition> {
  assertCan(ctx.role, 'journal', 'read')

  const fy = await prisma.financialYear.findFirst({ where: { id: financialYearId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')
  const first = await earliestYear(ctx.companyId)
  const eligible = first?.id === fy.id

  const entry = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'OPENING_BALANCE', sourceId: fy.id, reversalOfId: null },
    include: { lines: { include: { account: true } }, reversedBy: { select: { id: true } } },
    orderBy: { postedAt: 'desc' },
  })
  // an entry that has been reversed is not the position; the reversal is the other half of it
  const live = entry && !entry.reversedBy ? entry : null

  const lines = (live?.lines ?? []).map((l) => ({
    code: l.account.code, name: l.account.name, type: l.account.type as string,
    debit: new Decimal(l.debit.toString()), credit: new Decimal(l.credit.toString()),
  })).sort((a, b) => a.code.localeCompare(b.code))

  return {
    financialYearId: fy.id,
    fyLabel: fy.label,
    entryId: live?.id ?? null,
    postedOn: live?.date ?? null,
    lines,
    totalDebit: lines.reduce((a, l) => a.plus(l.debit), ZERO as Decimal),
    totalCredit: lines.reduce((a, l) => a.plus(l.credit), ZERO as Decimal),
    eligible,
    why: eligible
      ? 'The first year on this system — its opening position cannot be derived from anything here.'
      : `FY ${first?.label ?? 'the first year'} is the earliest year on this system. Every later year's opening position is the previous year's closing position, which the reports already read; an entry here would count it twice.`,
  }
}

/**
 * Set — or replace — the opening entry for the first financial year.
 *
 * 🔴 Replaces rather than appends. Opening balances get revised two or three times during a
 * migration, and appending would leave the ledger holding both. The previous entry is
 * REVERSED, not deleted: rule 2 of `docs/00 §3` applies to this as to everything else, and the
 * pair shows an auditor that the figures were restated and when.
 */
export async function setOpeningBalances(ctx: RequestContext, input: {
  financialYearId: string
  lines: OpeningLine[]
  note?: string
}) {
  assertCan(ctx.role, 'journal', 'approve')

  const fy = await prisma.financialYear.findFirst({
    where: { id: input.financialYearId, companyId: ctx.companyId },
  })
  if (!fy) throw new NotFound('Financial year not found')

  /**
   * 🔴 The earliest year only.
   *
   * Every report in this system reads cumulatively — `balanceSheet` starts at `new Date(0)` —
   * so a balance-sheet account already carries forward by itself. An opening entry in a later
   * year would be added to a balance that already includes it, and every asset, liability and
   * equity figure would double. Silently: the entry balances, the trial balance still
   * balances, and the only sign is that the numbers are twice what they should be.
   */
  const first = await earliestYear(ctx.companyId)
  if (first?.id !== fy.id) {
    throw new AppError(
      `Opening balances belong to FY ${first?.label ?? 'the first year'}, the earliest year on this system. ` +
      `FY ${fy.label}'s opening position is the previous year's closing position, which every report already ` +
      'reads — entering it again would count it twice.',
    )
  }

  const rows = input.lines
    .map((l) => ({
      accountCode: l.accountCode.trim(),
      debit: round2(new Decimal(l.debit || '0')),
      credit: round2(new Decimal(l.credit || '0')),
    }))
    .filter((l) => l.accountCode && (l.debit.gt(0) || l.credit.gt(0)))

  if (rows.length === 0) throw new AppError('An opening entry needs at least one line')
  if (rows.some((l) => l.debit.gt(0) && l.credit.gt(0))) {
    throw new AppError('A line is either a debit or a credit, not both')
  }

  const accounts = await prisma.account.findMany({
    where: { companyId: ctx.companyId, code: { in: rows.map((l) => l.accountCode) } },
  })
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  for (const l of rows) {
    const account = byCode.get(l.accountCode)
    if (!account) throw new AppError(`There is no account ${l.accountCode}`)
    /**
     * 🔴 Balance-sheet accounts only.
     *
     * An opening balance on an income or expense account would put last year's trading into
     * this year's profit and loss — the exact thing the year-end close exists to prevent. What
     * belongs in the opening position is the RESULT of that trading, in 3100 Retained
     * Earnings, which the person entering it has from their old books.
     */
    if (account.type === 'INCOME' || account.type === 'EXPENSE') {
      throw new AppError(
        `${account.code} ${account.name} is an ${account.type.toLowerCase()} account. An opening balance on it would ` +
        'put last year’s trading into this year’s P&L — put the result in 3100 Retained Earnings instead.',
      )
    }
  }

  const totalDebit = rows.reduce((a, l) => a.plus(l.debit), ZERO as Decimal)
  const totalCredit = rows.reduce((a, l) => a.plus(l.credit), ZERO as Decimal)
  if (!totalDebit.equals(totalCredit)) {
    throw new AppError(
      `The opening entry does not balance: ${formatINR(totalDebit)} of debits against ${formatINR(totalCredit)} of ` +
      'credits. At the moment a company starts keeping books, assets equal liabilities plus equity — the difference ' +
      'is usually retained earnings that has not been carried in.',
    )
  }

  const existing = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'OPENING_BALANCE', sourceId: fy.id, reversalOfId: null },
    include: { reversedBy: { select: { id: true } } },
    orderBy: { postedAt: 'desc' },
  })

  /**
   * 🔴 Dated the first day of the year, which means it reads as that year's first MOVEMENT
   * rather than appearing in the trial balance's opening column. The alternative — dating it
   * the day before — puts it in a year that does not exist here, or is closed. For a migration
   * year that is the honest presentation anyway: the opening entry is the first thing that
   * happened on this system.
   */
  const result = await prisma.$transaction(async (tx) => {
    if (existing && !existing.reversedBy) {
      await reverseJournal(ctx, existing.id, fy.startsOn, 'Opening balances restated', tx)
    }
    return postJournal(ctx, {
      date: fy.startsOn,
      narration: `Opening balances — FY ${fy.label}${input.note?.trim() ? ` · ${input.note.trim()}` : ''}`,
      sourceType: 'OPENING_BALANCE',
      sourceId: fy.id,
      postings: rows.map((l) => l.debit.gt(0)
        ? { accountCode: l.accountCode, debit: l.debit }
        : { accountCode: l.accountCode, credit: l.credit }),
    }, tx)
  })

  await audit(ctx, {
    entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    before: existing ? { restated: true, previousEntryId: existing.id } : undefined,
    after: { openingEntryId: result.id, lines: rows.length, total: totalDebit.toFixed(2) },
  })

  return result
}
