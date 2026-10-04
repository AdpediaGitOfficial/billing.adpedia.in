import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { setOpeningBalances, openingPosition } from '@/server/services/accounting/opening'
import { balanceSheet, trialBalance } from '@/server/services/reports/statements'
import type { RequestContext } from '@/server/context'

/** docs/74 — the one position this system cannot derive, and the one year it belongs to. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', first = '', later = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  // the seed carries 2025-26 (closed) and 2026-27 (open); reopen the earliest so it can take one
  const earliest = await prisma.financialYear.findFirstOrThrow({ where: { companyId }, orderBy: { startsOn: 'asc' } })
  await prisma.financialYear.update({ where: { id: earliest.id }, data: { status: 'OPEN', lockedUpTo: null } })
  first = earliest.id
  later = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id
})
afterAll(async () => { await prisma.$disconnect() })

const balanced = [
  { accountCode: '1010', debit: '850000' },     // bank
  { accountCode: '1100', debit: '400000' },     // receivables
  { accountCode: '2000', credit: '250000' },    // payables
  { accountCode: '3100', credit: '1000000' },   // retained earnings from the old books
]

/**
 * 🔴 The earliest year only.
 *
 * Every report reads cumulatively — `balanceSheet` starts at `new Date(0)` — so a
 * balance-sheet account already carries forward by itself. An opening entry in a later year is
 * added to a balance that already includes it, and every figure doubles. Silently: the entry
 * balances, the trial balance still balances, and the only sign is that the numbers are twice
 * what they should be.
 */
describe('🔴 which year an opening balance belongs to', () => {
  it('refuses a later year, and explains that it would be counted twice', async () => {
    await expect(setOpeningBalances(ctx, { financialYearId: later, lines: balanced }))
      .rejects.toThrow(/counted twice|count it twice/)
  })

  it('says the same thing when asked', async () => {
    const p = await openingPosition(ctx, later)
    expect(p.eligible).toBe(false)
    expect(p.why).toMatch(/count it twice/)

    expect((await openingPosition(ctx, first)).eligible).toBe(true)
  })
})

describe('what an opening entry may contain', () => {
  it('🔴 refuses an income or expense account', async () => {
    await expect(setOpeningBalances(ctx, {
      financialYearId: first,
      lines: [{ accountCode: '4010', credit: '100' }, { accountCode: '1010', debit: '100' }],
    })).rejects.toThrow(/would put last year/)
  })

  it('refuses one that does not balance, and names the difference', async () => {
    await expect(setOpeningBalances(ctx, {
      financialYearId: first,
      lines: [{ accountCode: '1010', debit: '500' }, { accountCode: '2000', credit: '400' }],
    })).rejects.toThrow(/does not balance/)
  })

  it('refuses a line that is both a debit and a credit', async () => {
    await expect(setOpeningBalances(ctx, {
      financialYearId: first,
      lines: [{ accountCode: '1010', debit: '1', credit: '1' }],
    })).rejects.toThrow(/not both/)
  })

  it('refuses an account that does not exist', async () => {
    await expect(setOpeningBalances(ctx, {
      financialYearId: first,
      lines: [{ accountCode: '9999', debit: '1' }, { accountCode: '1010', credit: '1' }],
    })).rejects.toThrow(/no account 9999/)
  })
})

describe('setting it', () => {
  it('posts one balanced entry, dated the first day of the year', async () => {
    const fy = await prisma.financialYear.findUniqueOrThrow({ where: { id: first } })
    const entry = await setOpeningBalances(ctx, { financialYearId: first, lines: balanced, note: 'From the Tally export' })
    expect(entry.date.toISOString().slice(0, 10)).toBe(fy.startsOn.toISOString().slice(0, 10))
    expect(entry.narration).toMatch(/From the Tally export/)

    const p = await openingPosition(ctx, first)
    expect(p.lines).toHaveLength(4)
    expect(p.totalDebit.toFixed(2)).toBe('1250000.00')
    expect(p.totalCredit.toFixed(2)).toBe('1250000.00')
  })

  it('shows up in the balance sheet, which still balances', async () => {
    const fy = await prisma.financialYear.findUniqueOrThrow({ where: { id: first } })
    const bs = await balanceSheet(ctx, fy.endsOn, fy.startsOn)
    expect(bs.balanced).toBe(true)
    expect(bs.assets.lines.find((l) => l.code === '1010')!.amount.toFixed(2)).toBe('850000.00')
    expect(bs.liabilities.lines.find((l) => l.code === '2000')!.amount.toFixed(2)).toBe('250000.00')
  })

  /**
   * 🔴 Restated, not appended. Opening balances get revised two or three times during a
   * migration, and appending would leave the ledger holding both. The previous entry is
   * reversed rather than deleted — rule 2 applies here as everywhere.
   */
  it('🔴 replaces the previous entry by reversing it, and both stay in the journal', async () => {
    await setOpeningBalances(ctx, {
      financialYearId: first,
      lines: [
        { accountCode: '1010', debit: '900000' },
        { accountCode: '1100', debit: '400000' },
        { accountCode: '2000', credit: '250000' },
        { accountCode: '3100', credit: '1050000' },
      ],
    })

    const p = await openingPosition(ctx, first)
    expect(p.totalDebit.toFixed(2)).toBe('1300000.00')
    expect(p.lines.find((l) => l.code === '1010')!.debit.toFixed(2)).toBe('900000.00')

    // three entries: the original, its reversal, and the restatement
    const all = await prisma.journalEntry.findMany({
      where: { companyId, OR: [{ sourceType: 'OPENING_BALANCE' }, { reversalOfId: { not: null } }] },
    })
    expect(all.filter((e) => e.sourceType === 'OPENING_BALANCE' && !e.reversalOfId)).toHaveLength(2)
    expect(all.some((e) => e.reversalOfId !== null)).toBe(true)

    // and the position is not doubled by the restatement
    const fy = await prisma.financialYear.findUniqueOrThrow({ where: { id: first } })
    const tb = await trialBalance(ctx, { from: fy.startsOn, to: fy.endsOn })
    expect(tb.balanced).toBe(true)
    expect(tb.rows.find((r) => r.code === '1010')!.closingDr.toFixed(2)).toBe('900000.00')
  })
})
