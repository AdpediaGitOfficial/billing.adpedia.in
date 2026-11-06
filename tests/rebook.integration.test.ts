import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal, ZERO } from '@/lib/money'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { postInvoice } from '@/server/services/accounting/rules/invoice'
import { postJournal } from '@/server/services/accounting/journal'
import { createReceipt } from '@/server/services/sales/receipt'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { previewRebook, rebookInvoiceAtRate, invoicesNeedingRebook } from '@/server/services/invoicing/rebook'
import { trialBalance } from '@/server/services/reports/statements'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

/**
 * docs/92 — correcting an issued foreign invoice that was booked at face value.
 *
 * 🔴 The "legacy" invoices here are built the way the old code built them: the same
 * `postInvoice`, with no rate. Sending one through the service today would book it at a rate,
 * which is the whole point of docs/91 and no use as a fixture.
 */

const prisma = new PrismaClient()
let ctx: RequestContext, ctxAuditor: RequestContext
let customerId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

async function legacyInvoice(date: string, usd: string, number: string) {
  const d = await createInvoice(ctx, {
    customerId, date, lines: [{ description: 'Film edit', quantity: '1', rate: usd, gstRatePct: '0', sacCode: '998397' }],
  })
  await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: d.id } })
    await tx.invoice.update({ where: { id: d.id }, data: { status: 'SENT', number, seq: 9000 + Number(number.slice(-3)), sentAt: new Date() } })
    await postJournal(ctx, {
      date: inv.date, narration: `Invoice ${number}`, sourceType: 'INVOICE', sourceId: inv.id,
      postings: postInvoice({
        number, customerId, grandTotal: new Decimal(inv.grandTotal.toString()),
        cgst: ZERO, sgst: ZERO, igst: ZERO, roundOff: ZERO,
        revenueByAccount: { '4010': new Decimal(inv.taxableValue.toString()) },
      }),
    }, tx)
  })
  return d.id
}

async function ar(invoiceCustomer = customerId) {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code: '1100' }, journalEntry: { companyId: ctx.companyId }, customerId: invoiceCustomer },
  })
  return lines.reduce((a, l) => a.plus(l.debit.toString()).minus(l.credit.toString()), ZERO)
}
async function income() {
  const lines = await prisma.journalLine.findMany({ where: { account: { code: '4010' }, journalEntry: { companyId: ctx.companyId } } })
  return lines.reduce((a, l) => a.plus(l.credit.toString()).minus(l.debit.toString()), ZERO)
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  ctxAuditor = { userId: user.id, companyId: company.id, role: 'AUDITOR' }
  await prisma.companyLut.create({ data: {
    companyId: company.id, arn: 'AD320326REBOOK1', fyLabel: '2026-27',
    validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31'),
  } })
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Ahura International', country: 'CN', stateCode: null,
    customerType: 'EXPORT', currency: 'USD', paymentTermDays: 30, billingAddress: { country: 'China' },
  } })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('re-booking an invoice that was posted at face value', () => {
  let id = ''

  it('the fixture is what the old code left: USD 250 in 1100 as 250', async () => {
    id = await legacyInvoice('2026-09-10', '250', 'LEGACY/26-27/001')
    expect((await ar()).toFixed(2)).toBe('250.00')
    expect((await invoicesNeedingRebook(ctx)).map((r) => r.id)).toEqual([id])
  })

  it('shows what it will post before posting it: only the difference, as the same heads', async () => {
    const p = await previewRebook(ctx, { invoiceId: id, fxRate: '84.25' })
    expect(p.blockers).toEqual([])
    const arLine = p.lines.find((l) => l.accountCode === '1100')!
    const rev = p.lines.find((l) => l.accountCode === '4010')!
    expect(arLine.was.toFixed(2)).toBe('250.00')
    expect(arLine.now.toFixed(2)).toBe('21062.50')
    expect(arLine.delta.toFixed(2)).toBe('20812.50')
    expect(rev.delta.toFixed(2)).toBe('-20812.50')   // credit
    // nothing has been posted by looking
    expect((await ar()).toFixed(2)).toBe('250.00')
  })

  it('refuses a rate of 1, a non-number and anyone who may not cancel an invoice', async () => {
    await expect(previewRebook(ctx, { invoiceId: id, fxRate: '1' })).rejects.toThrow(/"not entered" default/)
    await expect(previewRebook(ctx, { invoiceId: id, fxRate: 'abc' })).rejects.toThrow(/positive number/)
    await expect(previewRebook(ctxAuditor, { invoiceId: id, fxRate: '84' })).rejects.toThrow()
  })

  it('🔴 nothing can be posted against it while it is still at face value', async () => {
    await expect(createReceipt(ctx, {
      customerId, date: '2026-10-01', mode: 'SWIFT', inrAmount: '8000', allocations: [{ invoiceId: id, amount: '100' }],
    })).rejects.toThrow(/still booked at face value/)
    await expect(createCreditNote(ctx, { invoiceId: id, date: '2026-10-01', reason: 'Scope reduced by agreement', taxableValue: '10' }))
      .rejects.toThrow(/still booked at face value/)
  })

  it('🔴 posts the correction: receivables and income are rupees, the entry is its own, the invoice keeps its number', async () => {
    const r = await rebookInvoiceAtRate(ctx, { invoiceId: id, fxRate: '84.25' })
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } })
    expect(Number(inv.fxRate)).toBe(84.25)
    expect(inv.number).toBe('LEGACY/26-27/001')
    expect(Number(inv.grandTotal)).toBe(250)            // the document is untouched
    expect((await ar()).toFixed(2)).toBe('21062.50')
    expect((await income()).toFixed(2)).toBe('21062.50')

    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.entryId }, include: { lines: true } })
    expect(entry.sourceType).toBe('FX_REBOOK')
    expect(entry.sourceId).toBe(id)
    // dimensions survive: the customer is on the corrected receivable line, so the client ledger is right
    expect(entry.lines.every((l) => l.customerId === customerId)).toBe(true)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
    expect(await invoicesNeedingRebook(ctx)).toEqual([])
  })

  it('cannot be done twice', async () => {
    await expect(rebookInvoiceAtRate(ctx, { invoiceId: id, fxRate: '90' })).rejects.toThrow(/already booked at/)
  })

  it('the invoice then takes a receipt like any other, and clears to exactly zero', async () => {
    await createReceipt(ctx, {
      customerId, date: '2026-10-05', mode: 'SWIFT', inrAmount: '20900', allocations: [{ invoiceId: id, amount: '250' }],
    })
    expect((await ar()).toFixed(2)).toBe('0.00')
  })
})

describe('what stands in the way', () => {
  it('refuses while a receipt recorded at face value is still against the invoice, and says to cancel it', async () => {
    const id = await legacyInvoice('2026-09-12', '100', 'LEGACY/26-27/002')
    // the old receipt path: an allocation against the invoice and no rupee figure
    const rec = await prisma.receipt.create({ data: {
      companyId: ctx.companyId, financialYearId: (await prisma.invoice.findUniqueOrThrow({ where: { id } })).financialYearId,
      customerId, number: 'LEGACY-REC-1', date: new Date('2026-09-20'), mode: 'SWIFT', amount: '40.00',
    } })
    await prisma.receiptAllocation.create({ data: { receiptId: rec.id, invoiceId: id, amount: '40.00' } })
    const p = await previewRebook(ctx, { invoiceId: id, fxRate: '84' })
    expect(p.blockers.join(' ')).toMatch(/LEGACY-REC-1[\s\S]*Cancel it first/)
    await expect(rebookInvoiceAtRate(ctx, { invoiceId: id, fxRate: '84' })).rejects.toThrow(/Cancel it first/)
    // once the receipt is cancelled it no longer blocks
    await prisma.receipt.update({ where: { id: rec.id }, data: { cancelledAt: new Date() } })
    expect((await previewRebook(ctx, { invoiceId: id, fxRate: '84' })).blockers).toEqual([])
  })

  it('refuses a rupee invoice and a draft', async () => {
    const inr = await prisma.customer.create({ data: {
      companyId: ctx.companyId, name: 'A domestic client', country: 'IN', stateCode: '32',
      customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
    } })
    const d = await createInvoice(ctx, { customerId: inr.id, date: '2026-09-15',
      lines: [{ description: 'Edit', quantity: '1', rate: '1000', gstRatePct: '18', sacCode: '998397' }] })
    expect((await previewRebook(ctx, { invoiceId: d.id, fxRate: '84' })).blockers.join(' ')).toMatch(/is a draft/)
    const sent = await sendInvoice(ctx, d.id)
    expect((await previewRebook(ctx, { invoiceId: sent.id, fxRate: '84' })).blockers.join(' ')).toMatch(/in rupees/)
  })

  it('refuses a correction dated in a locked period, with the period lock\'s own words', async () => {
    const id = await legacyInvoice('2026-09-18', '60', 'LEGACY/26-27/003')
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: ctx.companyId, label: '2026-27' } })
    await prisma.financialYear.update({ where: { id: fy.id }, data: { lockedUpTo: new Date('2026-09-30') } })
    try {
      await expect(previewRebook(ctx, { invoiceId: id, fxRate: '84' })).rejects.toThrow(/locked/)
      // dated after the lock it is allowed, and the preview says the revenue lands in that period
      const p = await previewRebook(ctx, { invoiceId: id, fxRate: '84', date: '2026-10-05' })
      expect(p.blockers).toEqual([])
      expect(p.warnings.join(' ')).toMatch(/lands in that period/)
    } finally {
      await prisma.financialYear.update({ where: { id: fy.id }, data: { lockedUpTo: null } })
    }
  })
})

describe('cancelling a re-booked invoice', () => {
  it('🔴 reverses the correction as well as the original, leaving nothing in receivables or income', async () => {
    const before = { ar: await ar(), inc: await income() }
    const id = await legacyInvoice('2026-09-25', '80', 'LEGACY/26-27/004')
    await rebookInvoiceAtRate(ctx, { invoiceId: id, fxRate: '84' })
    expect((await ar()).minus(before.ar).toFixed(2)).toBe('6720.00')

    await cancelInvoice(ctx, id, 'Issued in error')
    // 🔴 reversing only the invoice's own entry would leave 6,720 - 80 = 6,640 behind
    expect((await ar()).minus(before.ar).toFixed(2)).toBe('0.00')
    expect((await income()).minus(before.inc).toFixed(2)).toBe('0.00')
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })
})
