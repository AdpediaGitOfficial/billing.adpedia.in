import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createAdvanceReceipt, adjustAdvance, openAdvances } from '@/server/services/sales/advance'
import { previewRefund, createRefundVoucher, listRefundVouchers } from '@/server/services/sales/refund'
import { renderVoucherHtml } from '@/server/services/sales/render-voucher'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { gstr1ToCsv } from '@/server/services/tax/gst-export'
import { accountLedger } from '@/server/services/reports/ledger'
import { trialBalance } from '@/server/services/reports/statements'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', keralaId = '', advanceId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const balance = async (code: string) => (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  keralaId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })).id

  const adv = await createAdvanceReceipt(ctx, {
    customerId: keralaId, date: '2026-05-05', amount: '118000', mode: 'NEFT',
    gstRatePct: '18', description: 'Advance for the Nuvé brand film',
  })
  advanceId = adv.id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 returning an advance', () => {
  it('splits the refund the way rule 50 split the receipt', async () => {
    const p = await previewRefund(ctx, { receiptId: advanceId, date: '2026-06-01', amount: '118000', reason: 'Project cancelled' })
    expect(p.available.toFixed(2)).toBe('118000.00')
    expect(p.taxableValue.toFixed(2)).toBe('100000.00')
    expect(p.cgst.toFixed(2)).toBe('9000.00')
    expect(p.sgst.toFixed(2)).toBe('9000.00')
    expect(p.taxBack.toFixed(2)).toBe('18000.00')
    expect(p.notes.join(' ')).toMatch(/tax-inclusive under rule 50/)
    expect(p.notes.join(' ')).toMatch(/not a credit note/)
  })

  it('🔴 demands a reason, because rule 51 puts it on the document', async () => {
    await expect(createRefundVoucher(ctx, {
      receiptId: advanceId, date: '2026-06-01', amount: '10000', reason: '  ',
    })).rejects.toThrow(/must say why the money is going back/)
  })

  it('refuses a refund dated before the advance arrived', async () => {
    await expect(createRefundVoucher(ctx, {
      receiptId: advanceId, date: '2026-05-01', amount: '10000', reason: 'Too early',
    })).rejects.toThrow(/cannot be dated before it/)
  })

  it('🔴 takes the output tax back out of the heads it was charged to', async () => {
    const cgstBefore = await balance('2110')
    const advanceBefore = await balance('2400')

    const v = await createRefundVoucher(ctx, {
      receiptId: advanceId, date: '2026-06-01', amount: '59000', reason: 'Half the project was cancelled',
    })
    expect(v.number).toMatch(/^ADPF\//)

    // half of ₹1,18,000: ₹50,000 of liability and ₹4,500 of each tax
    expect(Number(cgstBefore) - Number(await balance('2110'))).toBeCloseTo(4500, 2)
    expect(Number(advanceBefore) - Number(await balance('2400'))).toBeCloseTo(50000, 2)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('leaves only what is left available', async () => {
    const p = await previewRefund(ctx, { receiptId: advanceId, date: '2026-06-02', amount: '1', reason: 'x' })
    expect(p.available.toFixed(2)).toBe('59000.00')
    await expect(createRefundVoucher(ctx, {
      receiptId: advanceId, date: '2026-06-02', amount: '70000', reason: 'More than is left',
    })).rejects.toThrow(/Only ₹59,000.00 of advance/)
  })

  it('🔴 counts an adjustment against an invoice as spent too', async () => {
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: keralaId, date: '2026-06-10',
      lines: [{ description: 'Brand film', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18' }],
    })).id)
    await adjustAdvance(ctx, { receiptId: advanceId, invoiceId: inv.id, amount: '59000', date: '2026-06-10' })

    const p = await previewRefund(ctx, { receiptId: advanceId, date: '2026-06-11', amount: '1', reason: 'x' })
    expect(p.available.toFixed(2)).toBe('0.00')
    await expect(createRefundVoucher(ctx, {
      receiptId: advanceId, date: '2026-06-11', amount: '1000', reason: 'Nothing left',
    })).rejects.toThrow(/Only ₹0.00 of advance/)
  })

  it('🔴 drops out of the open advances once it is all gone', async () => {
    // `openAdvances` subtracted allocations and not refunds, so a fully refunded advance
    // stayed open — the screen offered to adjust money already returned to the client, and
    // the service would have taken output tax out of the same accounts twice.
    const open = await openAdvances(ctx)
    expect(open.find((a) => a.id === advanceId)).toBeUndefined()
  })
})

describe('🔴 the return', () => {
  it('reports the refund in table 11B, not as a credit note', async () => {
    const r = await buildGstr1(companyId, PERIOD.from, PERIOD.to, '2026-27')
    expect(r.advancesRefunded).toHaveLength(1)
    const row = r.advancesRefunded[0]
    expect(row.againstReceipt).toMatch(/^ADPR\//)
    expect(row.amount.toFixed(2)).toBe('59000.00')
    expect(row.cgst.toFixed(2)).toBe('4500.00')
    // and it is NOT in the credit-note table
    expect(r.creditNotes).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/not a credit note/)
    expect(r.warnings.join(' ')).toMatch(/Confirm the presentation with the CA/)
  })

  it('is its own block in the CSV the CA files from', async () => {
    const csv = gstr1ToCsv(await buildGstr1(companyId, PERIOD.from, PERIOD.to, '2026-27'))
    expect(csv).toContain('Advances REFUNDED, no supply made')
    expect(csv).toContain('s.31(3)(e)')
    expect(csv).toContain('Against Receipt Voucher')
  })
})

describe('🔴 the two vouchers, from one template', () => {
  it('prints a receipt voucher under rule 49', async () => {
    const html = await renderVoucherHtml(companyId, 'receipt', advanceId)
    expect(html).toContain('Receipt Voucher')
    expect(html).toMatch(/Section 31\(3\)\(d\)/)
    expect(html).toMatch(/Rule 49/)
    expect(html).toMatch(/Notification 66\/2017/)
    // 🔴 the CLASS ON THE SHEET, not the document — `.v-refund` appears in the stylesheet
    // of every voucher, which is how one template serves both
    expect(html).toMatch(/class="sheet v-receipt mode-\w+"/)
  })

  it('🔴 prints a refund voucher carrying the receipt voucher it refunds', async () => {
    const [v] = await listRefundVouchers(ctx)
    const html = await renderVoucherHtml(companyId, 'refund', v.id)
    expect(html).toContain('Refund Voucher')
    expect(html).toMatch(/Section 31\(3\)\(e\)/)
    expect(html).toMatch(/Rule 51/)
    expect(html).toContain('v-refund')
    // rule 51(c) — the number AND date of the receipt voucher
    expect(html).toMatch(new RegExp(`${v.receipt.number.replace(/\//g, '\\/')}`))
    expect(html).toMatch(/Half the project was cancelled/)
    expect(html).toMatch(/this is not a credit note/i)
  })

  it('shows CGST and SGST on a Kerala voucher and no IGST line', async () => {
    const [v] = await listRefundVouchers(ctx)
    const html = await renderVoucherHtml(companyId, 'refund', v.id)
    expect(html).toMatch(/class="sheet v-refund mode-intra"/)
  })

  it('🔴 prints the payment mode as NEFT, not neft', async () => {
    // lower-casing the enum for display put "neft" on a document going to a client
    const html = await renderVoucherHtml(companyId, 'receipt', advanceId)
    expect(html).toMatch(/>NEFT</)
    expect(html).not.toMatch(/>neft</)
  })

  it('🔴 does not repeat the line description under a second heading', async () => {
    // the receipt voucher had a "Particulars" block below a table column also headed
    // "Particulars", saying the same sentence again
    const html = await renderVoucherHtml(companyId, 'receipt', advanceId)
    expect(html).not.toContain('class="why"')
    const [v] = await listRefundVouchers(ctx)
    // a refund keeps it, because rule 51(f) requires the reason and it is not the description
    expect(await renderVoucherHtml(companyId, 'refund', v.id)).toContain('class="why"')
  })

  it('renders to a real PDF', async () => {
    const [v] = await listRefundVouchers(ctx)
    const pdf = await htmlToPdf(await renderVoucherHtml(companyId, 'refund', v.id))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(5000)
  })
})
