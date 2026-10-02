import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createAdvanceReceipt, previewAdvance, adjustAdvance, openAdvances, advanceTaxPosted } from '@/server/services/sales/advance'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { gstr1ToCsv } from '@/server/services/tax/gst-export'
import { gstPosition } from '@/server/services/tax/gst-ledger'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, kerala = '', noState = '', dubai = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const balance = async (code: string) =>
  (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  kerala = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
  noState = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'A New Enquiry', country: 'IN', stateCode: null,
    customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
  dubai = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Nuvé Holdings FZ-LLC', country: 'AE', stateCode: null,
    customerType: 'EXPORT', paymentTermDays: 30, currency: 'USD', billingAddress: {},
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 GST is payable on an advance for services', () => {
  let advanceId = ''

  it('backs the tax out of the money received, not on top of it', async () => {
    const p = await previewAdvance(ctx, {
      customerId: kerala, date: '2026-05-10', mode: 'NEFT', amount: '118000', gstRatePct: '18',
    })
    // ₹1,18,000 received IS the gross — rule 50 deems the advance to include the tax
    expect(p.taxableValue.toFixed(2)).toBe('100000.00')
    expect(p.cgst.toFixed(2)).toBe('9000.00')
    expect(p.sgst.toFixed(2)).toBe('9000.00')
    expect(p.taxMode).toBe('INTRA')
    expect(p.notes.join(' ')).toMatch(/Notification 66\/2017/)
    expect(p.notes.join(' ')).toMatch(/s\.13\(2\)/)
  })

  it('posts it as a liability with the tax, never as revenue', async () => {
    const r = await createAdvanceReceipt(ctx, {
      customerId: kerala, date: '2026-05-10', mode: 'NEFT', amount: '118000', gstRatePct: '18',
      description: 'Advance for the Q2 engagement',
    })
    advanceId = r.id
    expect(r.isAdvance).toBe(true)

    expect(await balance('2400')).toBe('100000.00')   // advances from customers
    expect(await balance('2110')).toBe('9000.00')
    expect(await balance('4010')).toBe('0.00')        // 🔴 nothing has been supplied yet
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('shows in the GST position for the period the money arrived', async () => {
    const pos = await gstPosition(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'))
    expect(pos.output.total.toFixed(2)).toBe('18000.00')
  })

  it('reports it in table 11A, at the rate it was actually charged', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'), '2026-Q1')
    expect(r.advancesReceived).toHaveLength(1)
    expect(r.advancesReceived[0].taxableValue.toFixed(2)).toBe('100000.00')
    expect(r.advancesReceived[0].rate).toBe(18)
    expect(r.warnings.join(' ')).toMatch(/Notification 66\/2017/)

    expect(gstr1ToCsv(r)).toContain('at — Advances received on which tax is payable (table 11A)')
  })

  it('lists what is still open', async () => {
    const open = await openAdvances(ctx, kerala)
    expect(open).toHaveLength(1)
    expect(open[0].open.toFixed(2)).toBe('118000.00')
    void advanceId
  })
})

describe('🔴 absorbing the advance into the invoice', () => {
  let invoiceId = '', advanceId = ''

  it('reverses the tax the advance paid, so the supply is not taxed twice', async () => {
    const advance = await prisma.receipt.findFirstOrThrow({ where: { companyId: ctx.companyId, isAdvance: true } })
    advanceId = advance.id

    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-08-20',
      lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
    })).id)
    invoiceId = inv.id

    // the invoice declares its own tax, so output GST is now doubled up
    expect(await balance('2110')).toBe('18000.00')

    await adjustAdvance(ctx, {
      receiptId: advance.id, invoiceId: inv.id, amount: '118000', date: '2026-08-20',
    })

    // 🔴 back to the invoice's own tax alone
    expect(await balance('2110')).toBe('9000.00')
    expect(await balance('2400')).toBe('0.00')
    expect(await balance('1100')).toBe('0.00')        // the invoice is settled by the advance
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('marks the invoice paid and closes the advance', async () => {
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe('PAID')
    expect(await openAdvances(ctx, kerala)).toHaveLength(0)
    const left = await advanceTaxPosted(ctx.companyId, advanceId)
    expect(left.cgst.toFixed(2)).toBe('0.00')
  })

  it('reports the adjustment in table 11B', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2026-07-01'), new Date('2026-09-30T23:59:59Z'), '2026-Q2')
    expect(r.advancesAdjusted).toHaveLength(1)
    expect(r.advancesAdjusted[0].cgst.toFixed(2)).toBe('9000.00')
    expect(gstr1ToCsv(r)).toContain('atadj — Advances adjusted against invoices (table 11B)')
  })

  it('refuses to adjust more than is left, or against another customer', async () => {
    await expect(adjustAdvance(ctx, { receiptId: advanceId, invoiceId, amount: '1000', date: '2026-08-21' }))
      .rejects.toThrow(/left to adjust/)
  })
})

describe('🔴 rule 50 — what to do when you do not know yet', () => {
  it('treats an unknown place of supply as inter-state', async () => {
    // IGST can be reapportioned between the states afterwards; CGST and SGST cannot
    const p = await previewAdvance(ctx, {
      customerId: noState, date: '2026-05-12', mode: 'NEFT', amount: '59000',
    })
    expect(p.taxMode).toBe('INTER')
    expect(p.igst.toFixed(2)).toBe('9000.00')
    expect(p.notes.join(' ')).toMatch(/reapportioned/)
  })

  it('takes 18% where the rate is not determinable', async () => {
    const p = await previewAdvance(ctx, {
      customerId: noState, date: '2026-05-12', mode: 'NEFT', amount: '59000',
    })
    expect(p.ratePct.toFixed(0)).toBe('18')
    expect(p.notes.join(' ')).toMatch(/rule 50/)
  })

  it('🔴 reverses the head that was actually charged, not the invoice’s', async () => {
    // the advance went to IGST because the state was unknown; the customer turns out to be
    // in Kerala, so the invoice is CGST+SGST. Reversing the invoice's heads would take tax
    // out of accounts that were never credited and leave the IGST stranded for ever.
    const advance = await createAdvanceReceipt(ctx, {
      customerId: noState, date: '2026-05-12', mode: 'NEFT', amount: '59000',
    })
    expect(await balance('2130')).toBe('9000.00')

    await prisma.customer.update({ where: { id: noState }, data: { stateCode: '32', gstin: '32AAACN1234N1Z5' } })
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: noState, date: '2026-09-05',
      lines: [{ description: 'Consulting', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18' }],
    })).id)
    expect(inv.taxMode).toBe('INTRA')

    await adjustAdvance(ctx, { receiptId: advance.id, invoiceId: inv.id, amount: '59000', date: '2026-09-05' })

    expect(await balance('2130')).toBe('0.00')        // the IGST that was paid comes back out
    expect(await balance('2110')).toBe('13500.00')    // 9,000 earlier + 4,500 on this invoice
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })
})

describe('an export advance', () => {
  it('carries no GST, and says why it still needs a voucher', async () => {
    const p = await previewAdvance(ctx, {
      customerId: dubai, date: '2026-05-15', mode: 'SWIFT', amount: '5000',
    })
    expect(p.taxMode).toBe('EXPORT')
    expect(p.cgst.plus(p.sgst).plus(p.igst).toFixed(2)).toBe('0.00')
    expect(p.taxableValue.toFixed(2)).toBe('5000.00')
    expect(p.notes.join(' ')).toMatch(/zero-rated/)
    expect(p.notes.join(' ')).toMatch(/FIRC/)
  })
})

describe('TDS withheld on an advance', () => {
  it('is booked as receivable even though no invoice exists', async () => {
    // a deduction follows the payment, not the invoice
    const r = await createAdvanceReceipt(ctx, {
      customerId: kerala, date: '2026-05-20', mode: 'NEFT', amount: '108000', tdsAmount: '10000', gstRatePct: '18',
    })
    const rec = await prisma.tdsReceivable.findFirstOrThrow({ where: { companyId: ctx.companyId, invoiceId: null } })
    expect(rec.tdsAmount.toString()).toBe('10000')
    expect(new Decimal(r.amount.toString()).plus(r.tdsAmount.toString()).toFixed(2)).toBe('118000.00')
    expect(await balance('1310')).toBe('10000.00')
  })
})
