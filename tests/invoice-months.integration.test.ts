import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { ZERO } from '@/lib/money'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { arSummary } from '@/server/services/sales/receivables'
import { invoicesByMonth } from '@/server/services/sales/invoice-months'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let kerala = '', dubai = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  kerala = (await prisma.customer.create({
    data: { companyId: company.id, name: 'Click AR Business Pvt Ltd', country: 'IN', stateCode: '32',
      customerType: 'B2B', billingAddress: {}, paymentTermDays: 15 },
  })).id
  dubai = (await prisma.customer.create({
    data: { companyId: company.id, name: 'Nuvé Holdings FZ-LLC', country: 'AE', stateCode: null,
      customerType: 'EXPORT', currency: 'USD', billingAddress: {}, paymentTermDays: 30 },
  })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const LINES = [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }]
const raise = async (date: string) =>
  sendInvoice(ctx, (await createInvoice(ctx, { customerId: kerala, date, lines: LINES })).id)

const monthsOf = async () => invoicesByMonth(ctx, '2026-27')
const month = async (key: string) => (await monthsOf()).find((m) => m.key === key)!

/**
 * What was billed, month by month — docs/83 §7.
 *
 * The list could be read by invoice and the tiles by financial year, and there was nothing in
 * between: "what did we bill in July" meant paging through a list ordered by date and adding
 * it up by eye.
 */
describe('🔴 the months of a financial year', () => {
  it('🔴 lists every one of them, including the months with nothing in it', async () => {
    const months = await monthsOf()
    expect(months).toHaveLength(12)
    // April first, March last — the Indian financial year, not the calendar one
    expect(months[0].key).toBe('2026-04')
    expect(months[11].key).toBe('2027-03')
    // and a month with nothing billed is present and zero, not absent
    expect(months[0].issued).toBe(0)
    expect(months[0].grandTotal.eq(ZERO)).toBe(true)
  })

  it('puts an invoice in the month of its own date', async () => {
    await raise('2026-07-10')
    const jul = await month('2026-07')
    expect(jul.issued).toBe(1)
    expect(jul.taxableValue.toString()).toBe('100000')
    expect(jul.gst.toString()).toBe('18000')
    expect(jul.grandTotal.toString()).toBe('118000')
    expect((await month('2026-06')).issued).toBe(0)
  })

  /**
   * 🔴 A month boundary is the thing this gets wrong if anything does. The 1st and the last
   * day of a month must land in their own month and nowhere else.
   */
  it('does not spill across a month boundary', async () => {
    await raise('2026-08-01')
    await raise('2026-08-31')
    expect((await month('2026-08')).issued).toBe(2)
    expect((await month('2026-07')).issued).toBe(1)
    expect((await month('2026-09')).issued).toBe(0)
  })

  /**
   * 🔴 Counted, not added up. A cancelled invoice keeps its number (docs/41) and has been
   * reversed, so including its value overstates what the month billed — and dropping the row
   * entirely would hide that something was raised and withdrawn, which is the question an
   * assessment asks.
   */
  it('🔴 counts a cancelled invoice and leaves it out of the money', async () => {
    const inv = await raise('2026-09-15')
    const before = await month('2026-09')
    expect(before.issued).toBe(1)

    await cancelInvoice(ctx, inv.id, 'Raised against the wrong project')
    const after = await month('2026-09')
    expect(after.cancelled).toBe(1)
    expect(after.issued).toBe(0)
    expect(after.grandTotal.eq(ZERO)).toBe(true)
    expect(after.outstanding.eq(ZERO)).toBe(true)
  })

  /** 🔴 A draft has taken no number and posted nothing — it is not billing. */
  it('🔴 counts a draft separately and leaves it out of the money', async () => {
    await createInvoice(ctx, { customerId: kerala, date: '2026-10-05', lines: LINES })
    const oct = await month('2026-10')
    expect(oct.drafts).toBe(1)
    expect(oct.issued).toBe(0)
    expect(oct.grandTotal.eq(ZERO)).toBe(true)
  })

  /**
   * 🔴 The cross-check that found the defect. The first version of `outstanding` was
   * grandTotal − received − tdsCredited and left out the TDS still EXPECTED, so the months
   * added up to ₹5,000 more than the Collectible tile beside them on the same screen — two
   * figures that both read as "what is owed", differing. docs/56 §2's "two balances with the
   * same name".
   */
  it('🔴 the months add up to the company position shown beside them', async () => {
    const months = await monthsOf()
    const summed = months.reduce((a, m) => a.plus(m.outstanding), ZERO)
    expect(summed.toString()).toBe((await arSummary(ctx)).total.toString())
  })

  it('follows a receipt down', async () => {
    const inv = await raise('2026-11-20')
    const before = await month('2026-11')
    expect(before.received.eq(ZERO)).toBe(true)

    await createReceipt(ctx, {
      customerId: kerala, date: '2026-11-25', mode: 'NEFT', reference: 'NEFT/0001',
      allocations: [{ invoiceId: inv.id, amount: '50000' }],
    })
    const after = await month('2026-11')
    expect(after.received.toString()).toBe('50000')
    expect(after.outstanding.lt(before.outstanding)).toBe(true)
  })

  /**
   * 🔴 docs/91 — a USD invoice is counted at the rate it was booked at.
   *
   * `Invoice.fxRate` used to be read nowhere, so it was 1 on every export and a USD grand total
   * added into a rupee column was wrong by two orders of magnitude while looking like a
   * number. The month view named such invoices instead of summing them. It still does for one
   * with NO rate — a document sent before rates were captured — and converts every other.
   */
  it('🔴 counts a USD invoice at its rate, and names one that has none instead of adding it at face value', async () => {
    // an export needs a LUT for the year or it cannot be zero-rated and will not send
    const lut = await prisma.companyLut.create({
      data: { companyId: ctx.companyId, arn: 'AD320326TEST01', fyLabel: '2026-27',
        validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31') },
    })
    const usd = await createInvoice(ctx, {
      customerId: dubai, date: '2026-12-09', fxRate: '84',
      lines: [{ description: 'Brand film', sacCode: '998387', quantity: '1', rate: '6500', gstRatePct: '0' }],
    })
    const sent = await sendInvoice(ctx, usd.id)
    expect(sent.currency, 'the export did not come out in USD').toBe('USD')
    await prisma.companyLut.delete({ where: { id: lut.id } })

    const dec = await month('2026-12')
    expect(dec.issued).toBe(1)
    expect(dec.foreignCurrency).toEqual([])
    // USD 6,500 at ₹84 — in the rupee columns, as rupees
    expect(dec.grandTotal.toFixed(2)).toBe('546000.00')
    expect(dec.taxableValue.toFixed(2)).toBe('546000.00')

    // a document that carries no rate is still not added at face value
    await prisma.invoice.update({ where: { id: sent.id }, data: { fxRate: 1 } })
    const legacy = await month('2026-12')
    expect(legacy.foreignCurrency).toEqual([{ currency: 'USD', count: 1 }])
    expect(legacy.grandTotal.eq(ZERO)).toBe(true)
    expect(legacy.taxableValue.eq(ZERO)).toBe(true)
  })

  it('marks the month the company is actually in, and only that one', async () => {
    const months = await invoicesByMonth(ctx, '2026-27', new Date('2026-11-04T06:00:00Z'))
    expect(months.filter((m) => m.current).map((m) => m.key)).toEqual(['2026-11'])
  })
})
