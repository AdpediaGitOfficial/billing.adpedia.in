import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { trialBalance, profitAndLoss, balanceSheet } from '@/server/services/reports/statements'
import { cashFlow } from '@/server/services/reports/cash-flow'
import { receivablesAgeing, payablesAgeing } from '@/server/services/reports/ageing'
import { clientPnl } from '@/server/services/reports/client-pnl'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let clickAr = '', paidInvoice = '', openInvoice = ''
const period = { from: new Date('2026-04-01'), to: new Date('2027-03-31') }
const fyStart = new Date('2026-04-01')

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  clickAr = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', billingAddress: {}, paymentTermDays: 15, defaultTdsSection: '194J',
  } })).id

  // one invoice settled net of TDS, one left open and overdue
  const a = await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId: clickAr, date: '2026-05-01', tdsSection: '194J',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
  paidInvoice = a.id
  // docs/80 — the default account, rather than whichever one the heap offers
  const bank = await prisma.companyBankAccount.findFirstOrThrow({ where: { companyId: company.id, isDefault: true } })
  await createReceipt(ctx, {
    customerId: clickAr, date: '2026-05-20', mode: 'NEFT', bankAccountId: bank.id,
    allocations: [{ invoiceId: a.id, amount: '108000', tdsAmount: '10000' }],
  })

  const b = await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId: clickAr, date: '2026-06-01', tdsSection: '194J',
    lines: [{ description: 'Design services', sacCode: '998391', quantity: '1', rate: '50000', gstRatePct: '18' }],
  })).id)
  openInvoice = b.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 the statements must agree with themselves', () => {
  it('the trial balance balances', async () => {
    const tb = await trialBalance(ctx, period)
    expect(tb.rows.length).toBeGreaterThan(0)
    expect(tb.difference.toString()).toBe('0')
    expect(tb.balanced).toBe(true)
    // movement columns too, not just closing
    expect(tb.totals.debit.toString()).toBe(tb.totals.credit.toString())
  })

  it('the balance sheet balances, because the P&L result is folded into equity', async () => {
    const bs = await balanceSheet(ctx, period.to, fyStart)
    expect(bs.balanced).toBe(true)
    expect(bs.difference.toString()).toBe('0')

    // and the figure that makes it balance is the SAME number the P&L reports —
    // if these ever drift, one of the two statements is lying
    const pnl = await profitAndLoss(ctx, period)
    expect(bs.currentYearProfit.toString()).toBe(pnl.netProfit.toString())

    // it is shown as derived, never posted: nothing hits account 3200 in the journal
    const posted = await prisma.journalLine.count({
      where: { account: { code: '3200' }, journalEntry: { companyId: ctx.companyId } },
    })
    expect(posted).toBe(0)
    expect(bs.equity.lines.find((l) => l.code === '3200')?.derived).toBe(true)
  })

  it('a balance sheet that ignored the P&L would NOT balance', async () => {
    // the guard behind the guard: prove the fold-in is doing real work, so a future
    // refactor that drops it fails loudly here instead of shipping a wrong statement
    const bs = await balanceSheet(ctx, period.to, fyStart)
    const withoutProfit = bs.equity.lines.filter((l) => !l.derived)
      .reduce((a, l) => a.plus(l.amount), new Decimal(0))
    expect(bs.totalAssets.equals(bs.liabilities.total.plus(withoutProfit))).toBe(false)
  })

  it('the cash flow ties back to the cash and bank accounts', async () => {
    const cf = await cashFlow(ctx, period)
    expect(cf.reconciles).toBe(true)
    expect(cf.closing.minus(cf.opening).toString()).toBe(cf.netChange.toString())
    // the receipt landed, and it is operating — not investing or financing
    expect(cf.sections.find((s) => s.bucket === 'OPERATING')).toBeTruthy()
  })

  it('🔴 attributes cash only to the legs that actually funded it', async () => {
    // The receipt posts Dr Bank 1,08,000 / Dr TDS Receivable 10,000 / Cr AR 1,18,000.
    // The TDS leg is a debit — the same side as the cash — so it funded nothing. Spreading
    // the inflow across every non-cash leg would report cash "received against TDS
    // Receivable", which never happened. The totals tie either way, so this error would
    // hide inside a report that looks perfectly correct.
    const cf = await cashFlow(ctx, period)
    const lines = cf.sections.flatMap((s) => s.lines)

    expect(lines.find((l) => l.code.startsWith('131'))).toBeUndefined()

    const ar = lines.find((l) => l.code === '1100')!
    expect(ar.inflow.toString()).toBe('108000')
  })

  it('P&L revenue equals the revenue the trial balance shows', async () => {
    const pnl = await profitAndLoss(ctx, period)
    const tb = await trialBalance(ctx, period)
    const tbRevenue = tb.rows.filter((r) => r.code.startsWith('40'))
      .reduce((a, r) => a.plus(r.credit).minus(r.debit), new Decimal(0))
    expect(pnl.revenue.total.toString()).toBe(tbRevenue.toString())
    // ₹1,00,000 + ₹50,000 taxable; GST is never revenue
    expect(pnl.revenue.total.toString()).toBe('150000')
  })
})

describe('ageing', () => {
  it('🔴 ages receivables NET of the TDS the client withholds', async () => {
    const ar = await receivablesAgeing(ctx, new Date('2026-08-01'))
    const doc = ar.parties[0].docs.find((d) => d.id === openInvoice)!

    // invoice is ₹59,000 gross, ₹5,000 of which the client must withhold u/s 194J.
    // Chasing the customer for ₹59,000 is chasing ₹5,000 they cannot legally pay us.
    expect(doc.outstanding.toString()).toBe('54000')
    expect(doc.tdsWithheld.toString()).toBe('5000')
    expect(ar.tdsWithheldTotal.toString()).toBe('5000')

    // the settled invoice is gone from the ageing entirely
    expect(ar.parties[0].docs.find((d) => d.id === paidInvoice)).toBeUndefined()
  })

  it('buckets by how far past due, not by invoice age', async () => {
    // raised 01 Jun, 15-day terms -> due 16 Jun; at 01 Aug that is 46 days late
    const ar = await receivablesAgeing(ctx, new Date('2026-08-01'))
    const doc = ar.parties[0].docs.find((d) => d.id === openInvoice)!
    expect(doc.bucket).toBe('31–60')

    // same invoice, asked about on the day it was raised: not due at all
    const early = await receivablesAgeing(ctx, new Date('2026-06-01'))
    expect(early.parties[0].docs.find((d) => d.id === openInvoice)!.bucket).toBe('Not due')
  })

  it('reports no payables when nothing is approved', async () => {
    const ap = await payablesAgeing(ctx, new Date('2026-08-01'))
    expect(ap.grandTotal.toString()).toBe('0')
    expect(ap.parties).toHaveLength(0)
  })
})

describe('drill-through', () => {
  it('every revenue figure resolves to the journal lines behind it', async () => {
    const led = await accountLedger(ctx, '4020', period)
    expect(led).toBeTruthy()
    const total = led!.lines.reduce((a, l) => a.plus(l.credit).minus(l.debit), new Decimal(0))
    expect(total.toString()).toBe(led!.account.closing.toString())
    // and each line names the document that produced it
    for (const l of led!.lines) expect(l.sourceType).toBeTruthy()
  })

  it('the running balance on the last line IS the closing balance', async () => {
    const led = await accountLedger(ctx, '1100', period)   // accounts receivable
    expect(led!.lines.length).toBeGreaterThan(0)
    expect(led!.lines.at(-1)!.balance.toString()).toBe(led!.account.closing.toString())
  })

  it('returns null for an account that does not exist rather than throwing', async () => {
    expect(await accountLedger(ctx, '9999', period)).toBeNull()
  })
})

describe('client P&L', () => {
  it('groups the same journal lines by customer', async () => {
    const rows = await clientPnl(ctx, period)
    const click = rows.find((r) => r.customerId === clickAr)!
    expect(click.revenue.toString()).toBe('150000')
    // ₹59,000 gross less ₹5,000 TDS not yet credited = still shown as open at gross,
    // because the TDS has not been credited to the invoice yet
    expect(click.outstanding.gt(0)).toBe(true)
  })
})
