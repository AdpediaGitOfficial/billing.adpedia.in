import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal, ZERO } from '@/lib/money'
import { createVendor } from '@/server/services/purchases/vendor'
import { previewBill, createBill, approveBill, payBill, cancelBill } from '@/server/services/purchases/bill'
import { cancelBillPayment } from '@/server/services/accounting/corrections'
import { apSummary } from '@/server/services/purchases/payables'
import { payablesAgeing } from '@/server/services/reports/ageing'
import { trialBalance } from '@/server/services/reports/statements'
import type { RequestContext } from '@/server/context'

/**
 * docs/93 — a vendor bill in a foreign currency, in rupees.
 *
 * 🔴 There was no way to enter one: the bill form had no currency, so a $100 bill had to be
 * keyed as 100 and posted ₹100, and the reverse charge and the s.195 TDS were worked out on it.
 * These tests read the JOURNAL, because that is where the defect lived.
 */

const prisma = new PrismaClient()
let ctx: RequestContext
let digitalOcean = '', afrizon = '', domestic = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const line = (rate: string, qty = '1') => [{ description: 'Hosting', quantity: qty, rate, gstRatePct: '18', expenseAccountCode: '5210' }]

/** what payables (2000) holds, for one vendor or all */
async function ap(vendorId?: string) {
  const rows = await prisma.journalLine.findMany({
    where: { account: { code: '2000' }, journalEntry: { companyId: ctx.companyId }, ...(vendorId ? { vendorId } : {}) },
  })
  return rows.reduce((a, l) => a.plus(l.credit.toString()).minus(l.debit.toString()), ZERO)
}
async function linesOf(sourceId: string, code: string) {
  const entries = await prisma.journalEntry.findMany({ where: { sourceId }, include: { lines: { include: { account: true } } } })
  return entries.flatMap((e) => e.lines).filter((l) => l.account.code === code)
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  digitalOcean = (await createVendor(ctx, { name: 'DigitalOcean LLC', vendorType: 'CLOUD', country: 'US' })).id
  afrizon = (await createVendor(ctx, { name: 'Afrizon Crenergy Trade Pte', vendorType: 'OTHER', country: 'SG', defaultTdsSection: '195' })).id
  domestic = (await createVendor(ctx, { name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F' })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('a foreign bill is booked in rupees at the rate it carries', () => {
  let billId = ''

  it('previews the rupee figure, and works the reverse charge on it, not on the dollars', async () => {
    const p = await previewBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-1', billDate: '2026-09-05', currency: 'USD', fxRate: '84', lines: line('100') })
    expect(p.currency).toBe('USD')
    expect(p.grandTotal.toFixed(2)).toBe('100.00')          // the bill, in dollars
    expect(p.grandTotalInr!.toFixed(2)).toBe('8400.00')     // the ledger, in rupees
    expect(p.rcmIgst.toFixed(2)).toBe('1512.00')            // 18% of ₹8,400 — not of 100
  })

  it('cannot be saved without a rate, and says what to enter', async () => {
    await expect(createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-NR', billDate: '2026-09-05', currency: 'USD', lines: line('100') }))
      .rejects.toThrow(/Enter the exchange rate for this USD bill/)
    await expect(createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-BAD', billDate: '2026-09-05', currency: 'USD', fxRate: 'abc', lines: line('100') }))
      .rejects.toThrow(/positive number/)
    await expect(previewBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-C', billDate: '2026-09-05', currency: 'dollars', lines: line('100') }))
      .rejects.toThrow(/three-letter code/)
  })

  it('🔴 USD 100 at 84 posts ₹8,400 to the expense and to payables — not ₹100', async () => {
    const bill = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-1', billDate: '2026-09-05', currency: 'USD', fxRate: '84', lines: line('100') })
    billId = bill.id
    expect(bill.currency).toBe('USD')
    expect(Number(bill.grandTotal)).toBe(100)
    expect(Number(bill.grandTotalInr)).toBe(8400)
    expect(Number(bill.rcmIgst)).toBe(1512)
    await approveBill(ctx, bill.id)

    expect(Number((await linesOf(bill.id, '5210'))[0].debit)).toBe(8400)
    expect(Number((await linesOf(bill.id, '2000'))[0].credit)).toBe(8400)
    // the reverse charge self-invoice is in rupees too
    const rcm = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: 'SELF_INVOICE', sourceId: bill.id }, include: { lines: { include: { account: true } } } })
    expect(Number(rcm.lines.find((l) => l.account.code === '1240')!.debit)).toBe(1512)
    expect(Number(rcm.lines.find((l) => l.account.code === '2140')!.credit)).toBe(1512)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('refuses a payment that does not say what left the bank, and rupees on a rupee bill', async () => {
    await expect(payBill(ctx, { billId, date: '2026-09-20', amount: '40', mode: 'SWIFT' })).rejects.toThrow(/Enter the rupees that left the bank/)
    const inr = await createBill(ctx, { vendorId: domestic, billNumber: 'EX-1', billDate: '2026-09-06', lines: line('1000') })
    await approveBill(ctx, inr.id)
    await expect(payBill(ctx, { billId: inr.id, date: '2026-09-20', amount: '1000', inrAmount: '1000', mode: 'NEFT' }))
      .rejects.toThrow(/only for a foreign-currency bill/)
  })

  it('🔴 two part-payments at different rates clear payables to exactly zero, the difference to forex', async () => {
    // USD 40 costs ₹3,450 against ₹3,360 of payable → a ₹90 loss
    const p1 = await payBill(ctx, { billId, date: '2026-09-20', amount: '40', inrAmount: '3450', mode: 'SWIFT' })
    expect(Number(p1.inrAmount)).toBe(3450)
    expect(Number((await linesOf(p1.id, '2000'))[0].debit)).toBe(3360)
    expect(Number((await linesOf(p1.id, '5900'))[0].debit)).toBe(90)
    expect((await ap(digitalOcean)).toFixed(2)).toBe('5040.00')

    // the last USD 60 costs ₹4,950 against ₹5,040 → a ₹90 gain
    const p2 = await payBill(ctx, { billId, date: '2026-10-02', amount: '60', inrAmount: '4950', mode: 'SWIFT' })
    expect(Number((await linesOf(p2.id, '2000'))[0].debit)).toBe(5040)
    expect(Number((await linesOf(p2.id, '4920'))[0].credit)).toBe(90)
    expect((await ap(digitalOcean)).toFixed(2)).toBe('0.00')
    expect((await prisma.vendorBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe('PAID')
    // and the bank holds exactly what left it
    expect(Number((await linesOf(p1.id, '1010'))[0].credit)).toBe(3450)
  })
})

describe('TDS on a foreign bill is decided in rupees', () => {
  it('🔴 the s.195 deduction, the 27Q row and the payable are rupees, and an awkward rate still clears to zero', async () => {
    const rate = '83.456789'
    const p = await previewBill(ctx, { vendorId: afrizon, billNumber: 'AF-P', billDate: '2026-09-10', currency: 'USD', fxRate: rate, lines: line('333.33') })
    expect(p.tds.applies).toBe(true)
    const taxableInr = new Decimal('333.33').mul(rate).toDecimalPlaces(2)
    expect(p.tds.applyOn.toFixed(2)).toBe(taxableInr.toFixed(2))      // the base is rupees

    const bill = await createBill(ctx, { vendorId: afrizon, billNumber: 'AF-1', billDate: '2026-09-10', currency: 'USD', fxRate: rate, lines: line('333.33') })
    // the rupee deduction is kept exactly; the bill's own currency carries its equivalent
    expect(Number(bill.tdsAmountInr)).toBe(Number(p.tds.tdsAmount))
    expect(Math.abs(Number(bill.tdsAmount) * Number(rate) - Number(bill.tdsAmountInr))).toBeLessThan(0.5)
    await approveBill(ctx, bill.id)

    const ded = await prisma.tdsDeduction.findFirstOrThrow({ where: { documentId: bill.id } })
    expect(Number(ded.tdsAmount)).toBe(Number(bill.tdsAmountInr))
    expect(ded.baseAmount.toString()).toBe(taxableInr.toFixed(2))

    // payables is credited the rupee bill and debited the rupee TDS: it carries the rest
    const carried = new Decimal(bill.grandTotalInr!.toString()).minus(bill.tdsAmountInr!.toString())
    expect((await ap(afrizon)).toFixed(2)).toBe(carried.toFixed(2))

    // pay what the vendor is owed in dollars, in two goes at awkward amounts
    const owed = new Decimal(bill.grandTotal.toString()).minus(bill.tdsAmount.toString())
    const first = owed.div(3).toDecimalPlaces(2)
    await payBill(ctx, { billId: bill.id, date: '2026-10-05', amount: first.toFixed(2), inrAmount: '5000', mode: 'SWIFT' })
    await payBill(ctx, { billId: bill.id, date: '2026-10-09', amount: owed.minus(first).toFixed(2), inrAmount: '10000', mode: 'SWIFT' })
    // 🔴 not a paisa left, whatever the rounding did
    expect((await ap(afrizon)).toFixed(2)).toBe('0.00')
  })
})

describe('a bill closed within the half-unit tolerance', () => {
  it('🔴 settles exactly what is left, not a proportion of it', async () => {
    const b = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-TOL', billDate: '2026-10-20', currency: 'USD', fxRate: '84.5', lines: line('100') })
    await approveBill(ctx, b.id)
    const before = await ap(digitalOcean)
    // USD 99.80 closes a USD 100.00 bill (the system treats anything within 0.50 as settled), and
    // a payment that closes the bill must leave nothing in payables — not 0.2% of it
    await payBill(ctx, { billId: b.id, date: '2026-10-25', amount: '99.80', inrAmount: '8430', mode: 'SWIFT' })
    expect((await prisma.vendorBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('PAID')
    expect((await ap(digitalOcean)).minus(before).plus('8450').toFixed(2)).toBe('0.00')
  })
})

describe('what adds bills up speaks rupees', () => {
  it('the payables total and the payables ageing agree with 2000', async () => {
    const usd = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-2', billDate: '2026-11-01', currency: 'USD', fxRate: '83.5', lines: line('50') })
    await approveBill(ctx, usd.id)
    const inr = await createBill(ctx, { vendorId: domestic, billNumber: 'EX-2', billDate: '2026-11-02', lines: line('2000') })
    await approveBill(ctx, inr.id)

    const summary = await apSummary(ctx)
    const ageing = await payablesAgeing(ctx)
    const books = await ap()
    // both open bills (₹4,175 and ₹2,000) plus the earlier open rupee bill (₹1,000) — dollars
    // added at face value would have made this 50 + 2,000 + 1,000
    expect(summary.total.toFixed(2)).toBe(books.toFixed(2))
    expect(ageing.grandTotal.toFixed(2)).toBe(books.toFixed(2))
  })
})

describe('reversals', () => {
  it('cancelling a foreign bill reverses it in rupees and leaves nothing behind', async () => {
    const before = await ap(digitalOcean)
    const b = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-3', billDate: '2026-11-05', currency: 'USD', fxRate: '84', lines: line('10') })
    await approveBill(ctx, b.id)
    expect((await ap(digitalOcean)).minus(before).toFixed(2)).toBe('840.00')
    await cancelBill(ctx, b.id, 'Entered twice')
    expect((await ap(digitalOcean)).minus(before).toFixed(2)).toBe('0.00')
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('a payment cancelled and entered again still ends at exactly zero', async () => {
    const b = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-4', billDate: '2026-11-06', currency: 'USD', fxRate: '84.123457', lines: line('77.77') })
    await approveBill(ctx, b.id)
    const before = await ap(digitalOcean)
    const wrong = await payBill(ctx, { billId: b.id, date: '2026-11-10', amount: '30', inrAmount: '2600', mode: 'SWIFT' })
    await cancelBillPayment(ctx, wrong.id, 'Wrong amount keyed')
    // the failed payment left nothing behind in payables
    expect((await ap(digitalOcean)).toFixed(2)).toBe(before.toFixed(2))
    await payBill(ctx, { billId: b.id, date: '2026-11-11', amount: '77.77', inrAmount: '6500', mode: 'SWIFT' })
    expect((await ap(digitalOcean)).minus(before).plus(new Decimal(b.grandTotalInr!.toString())).toFixed(2)).toBe('0.00')
  })
})
