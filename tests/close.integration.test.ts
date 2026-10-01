import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { closingPreflight, closeYear, reopenYear, lockPeriod, unlockPeriod, createNextFinancialYear } from '@/server/services/accounting/close'
import { balanceSheet, profitAndLoss, trialBalance } from '@/server/services/reports/statements'
import { postJournal } from '@/server/services/accounting/journal'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, fyId = '', nextFyId = '', customerId = ''
const FY_START = new Date('2026-04-01'), FY_END = new Date('2027-03-31T23:59:59Z')

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })).id

  // a following year must exist — corrections need somewhere to go
  nextFyId = (await prisma.financialYear.create({ data: {
    companyId: company.id, label: '2027-28',
    startsOn: new Date('2027-04-01'), endsOn: new Date('2028-03-31T23:59:59Z'), status: 'OPEN',
  } })).id

  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id

  await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-01',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('period lock', () => {
  it('🔴 refuses a posting dated inside the locked period', async () => {
    await lockPeriod(ctx, fyId, new Date('2026-06-30'))
    await expect(postJournal(ctx, {
      date: new Date('2026-05-15'), narration: 'Late adjustment', sourceType: 'MANUAL',
      postings: [{ accountCode: '5500', debit: new Decimal('100') }, { accountCode: '1010', credit: new Decimal('100') }],
    })).rejects.toThrow(/locked/i)
  })

  it('still accepts a posting after the lock date', async () => {
    const e = await postJournal(ctx, {
      date: new Date('2026-07-15'), narration: 'Office supplies', sourceType: 'MANUAL',
      postings: [{ accountCode: '5500', debit: new Decimal('100') }, { accountCode: '1010', credit: new Decimal('100') }],
    })
    expect(e.id).toBeTruthy()
  })

  it('🔴 will not move the lock backwards through the ordinary path', async () => {
    // that would silently reopen a month whose GST return has been filed
    await expect(lockPeriod(ctx, fyId, new Date('2026-05-31'))).rejects.toThrow(/backwards/i)
  })

  it('unlocking is a separate action and demands a reason', async () => {
    await expect(unlockPeriod(ctx, fyId, null, 'oops')).rejects.toThrow(/needs a reason/)
    await unlockPeriod(ctx, fyId, null, 'Reversing an incorrect lock set during setup')
    const fy = await prisma.financialYear.findUniqueOrThrow({ where: { id: fyId } })
    expect(fy.lockedUpTo).toBeNull()
  })
})

describe('closing preflight', () => {
  it('blocks on a draft invoice, which closing would strand', async () => {
    const draft = await createInvoice(ctx, {
      customerId, date: '2026-06-01',
      lines: [{ description: 'Later work', sacCode: '998314', quantity: '1', rate: '5000', gstRatePct: '18' }],
    })
    const pre = await closingPreflight(ctx, fyId)
    const check = pre.checks.find((c) => c.label === 'No draft invoices')!
    expect(check.ok).toBe(false)
    expect(pre.canClose).toBe(false)

    // cancel, never delete — the database refuses a hard delete on financial records, and
    // "send or cancel them" is exactly what the check tells the user to do
    await cancelInvoice(ctx, draft.id, 'Raised in error during year-end testing', new Date('2026-07-01'))
  })

  it('reports the profit it is about to move, matching the P&L', async () => {
    const pre = await closingPreflight(ctx, fyId)
    const pnl = await profitAndLoss(ctx, { from: FY_START, to: FY_END })
    expect(pre.netProfit.toString()).toBe(pnl.netProfit.toString())
    expect(pre.canClose).toBe(true)
  })
})

describe('🔴 closing the year', () => {
  it('zeroes every P&L account and books the result to retained earnings', async () => {
    const before = await profitAndLoss(ctx, { from: FY_START, to: FY_END })
    const result = await closeYear(ctx, fyId)
    expect(result.netProfit.toString()).toBe(before.netProfit.toString())

    // income and expense now have no net movement at all
    const after = await profitAndLoss(ctx, { from: FY_START, to: FY_END })
    expect(after.totalIncome.toString()).toBe('0')
    expect(after.totalExpenses.toString()).toBe('0')
    expect(after.netProfit.toString()).toBe('0')
  })

  it('posts the profit to 3100, and nothing to 3200', async () => {
    const retained = await prisma.journalLine.aggregate({
      where: { account: { companyId: ctx.companyId, code: '3100' } },
      _sum: { credit: true, debit: true },
    })
    expect(new Decimal(retained._sum.credit?.toString() ?? '0')
      .minus(retained._sum.debit?.toString() ?? '0').isZero()).toBe(false)

    // 3200 stays a reporting bucket — sweeping into it would stack every closed year's
    // profit in one account nobody can read
    const cyp = await prisma.journalLine.count({ where: { account: { companyId: ctx.companyId, code: '3200' } } })
    expect(cyp).toBe(0)
  })

  it('🔴 the balance sheet still balances, and does NOT double-count the profit', async () => {
    // the whole risk: the statement used to DERIVE the profit into equity. Now it is posted.
    // If the derived line were still added on top, assets would exceed L+E by the profit.
    const bs = await balanceSheet(ctx, FY_END, FY_START)
    expect(bs.balanced).toBe(true)
    expect(bs.difference.toString()).toBe('0')
    expect(bs.currentYearProfit.toString()).toBe('0')
    expect(bs.equity.lines.find((l) => l.derived)).toBeUndefined()

    // and the trial balance is still square
    expect((await trialBalance(ctx, { from: FY_START, to: FY_END })).balanced).toBe(true)
  })

  it('locks the year against any further posting', async () => {
    await expect(postJournal(ctx, {
      date: new Date('2026-08-01'), narration: 'Too late', sourceType: 'MANUAL',
      postings: [{ accountCode: '5500', debit: new Decimal('50') }, { accountCode: '1010', credit: new Decimal('50') }],
    })).rejects.toThrow(/closed/i)
  })

  it('refuses to close twice', async () => {
    await expect(closeYear(ctx, fyId)).rejects.toThrow(/already closed/i)
  })
})

describe('🔴 reopening', () => {
  it('reverses the closing entry rather than deleting it', async () => {
    const before = await prisma.journalEntry.count({
      where: { companyId: ctx.companyId, sourceType: 'YEAR_END_CLOSE' },
    })
    await reopenYear(ctx, fyId, 'CA found an unrecorded expense for March')
    const after = await prisma.journalEntry.findMany({
      where: { companyId: ctx.companyId, sourceType: 'YEAR_END_CLOSE' },
    })

    // both entries survive — deleting the close would erase the evidence it ever happened
    expect(after.length).toBe(before + 1)
    expect(after.filter((e) => e.reversalOfId).length).toBe(1)
  })

  it('restores the P&L to what it was', async () => {
    const pnl = await profitAndLoss(ctx, { from: FY_START, to: FY_END })
    expect(pnl.totalIncome.gt(0)).toBe(true)
    expect(pnl.netProfit.isZero()).toBe(false)
  })

  it('and the balance sheet balances again, now deriving the profit as before', async () => {
    const bs = await balanceSheet(ctx, FY_END, FY_START)
    expect(bs.balanced).toBe(true)
    expect(bs.difference.toString()).toBe('0')
  })

  it('demands a reason', async () => {
    await expect(reopenYear(ctx, nextFyId, 'no')).rejects.toThrow(/needs a reason/)
  })
})

describe('🔴 opening the next financial year', () => {
  it('carries the numbering series across with the sequence reset', async () => {
    // DocumentSeries is per financial year. Without the carry-over the first invoice of the
    // new year has no series to draw a number from and simply fails — on 1 April, with a
    // client waiting.
    // 🔴 the fixture year 2027-28 was created BARE, with no series. The template must come
    // from the most recent year that actually has them, or the new year gets none either.
    const bare = await prisma.documentSeries.count({ where: { financialYearId: nextFyId } })
    expect(bare).toBe(0)

    const created = await createNextFinancialYear(ctx)
    expect(created.label).toBe('2028-29')
    expect(created.seriesCopied).toBeGreaterThan(0)

    const copied = await prisma.documentSeries.findMany({
      where: { companyId: ctx.companyId, financialYearId: created.id },
    })
    expect(copied.length).toBe(created.seriesCopied)
    // the sequence restarts: ADP/28-29/0001, never continuing last year's count
    for (const s of copied) expect(s.nextSeq).toBe(1)
    // and the pattern is unchanged — {FY} renders from the new year's own label
    for (const s of copied) expect(s.pattern).toContain('{FY}')
  })

  it('keeps going year on year, each still carrying the series', async () => {
    const next = await createNextFinancialYear(ctx)
    expect(next.label).toBe('2029-30')
    expect(next.seriesCopied).toBeGreaterThan(0)
  })

  it('runs 1 April to 31 March', async () => {
    const fy = await prisma.financialYear.findFirstOrThrow({
      where: { companyId: ctx.companyId, label: '2028-29' },
    })
    expect(fy.startsOn.toISOString().slice(0, 10)).toBe('2028-04-01')
    expect(fy.endsOn.toISOString().slice(0, 10)).toBe('2029-03-31')
  })
})
