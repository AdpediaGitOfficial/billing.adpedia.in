import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { createCreditNote, previewCreditNote } from '@/server/services/invoicing/credit-note'
import { trialBalance } from '@/server/services/reports/statements'
import { gstPosition } from '@/server/services/tax/gst-ledger'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = ''
const FROM = new Date('2026-04-01'), TO = new Date('2027-03-31T23:59:59Z')

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

const invoice = () => createInvoice(ctx, {
  customerId, date: '2026-05-01',
  lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
}).then((d) => sendInvoice(ctx, d.id))

describe('🔴 the dead end this closes', () => {
  it('cancelInvoice refuses once money has arrived, and points at a credit note', async () => {
    const inv = await invoice()
    await createReceipt(ctx, {
      customerId, date: '2026-05-20', mode: 'NEFT',
      allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })
    await expect(cancelInvoice(ctx, inv.id, 'Client disputed the scope'))
      .rejects.toThrow(/raise a credit note instead/)

    // ...and now that route actually exists
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-01', reason: 'Scope reduced by agreement', full: true,
    })
    expect(note.number).toMatch(/^ADPC\//)
  })
})

describe('issuing a credit note', () => {
  it('carries the invoice’s own tax split', async () => {
    const inv = await invoice()
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-01', reason: 'Deficiency in service', taxableValue: '20000',
    })
    expect(note.cgst.toString()).toBe('1800')     // 9% — the rate as invoiced
    expect(note.sgst.toString()).toBe('1800')
    expect(note.igst.toString()).toBe('0')
    expect(note.grandTotal.toString()).toBe('23600')
  })

  it('🔴 reverses the output GST, which is what reduces the liability', async () => {
    const before = await gstPosition(ctx.companyId, FROM, TO)
    const inv = await invoice()
    const during = await gstPosition(ctx.companyId, FROM, TO)
    expect(during.output.total.gt(before.output.total)).toBe(true)

    await createCreditNote(ctx, { invoiceId: inv.id, date: '2026-06-02', reason: 'Billed in error', full: true })

    const after = await gstPosition(ctx.companyId, FROM, TO)
    expect(after.output.total.toFixed(2)).toBe(before.output.total.toFixed(2))
  })

  it('leaves the trial balance square', async () => {
    expect((await trialBalance(ctx, { from: FROM, to: TO })).balanced).toBe(true)
  })

  it('🔴 refuses to credit more than is left on the invoice', async () => {
    const inv = await invoice()
    await createCreditNote(ctx, { invoiceId: inv.id, date: '2026-06-03', reason: 'Partial credit', taxableValue: '60000' })
    await expect(createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-04', reason: 'The rest and then some', taxableValue: '60000',
    })).rejects.toThrow(/exceeds the/)
  })

  it('demands a reason, because GSTR-1 reports it', async () => {
    const inv = await invoice()
    await expect(createCreditNote(ctx, { invoiceId: inv.id, date: '2026-06-05', reason: 'x', full: true }))
      .rejects.toThrow(/needs a reason/)
  })

  it('will not credit a draft', async () => {
    const draft = await createInvoice(ctx, {
      customerId, date: '2026-05-01',
      lines: [{ description: 'Work', sacCode: '998314', quantity: '1', rate: '1000', gstRatePct: '18' }],
    })
    await expect(createCreditNote(ctx, { invoiceId: draft.id, date: '2026-06-06', reason: 'Not issued yet', full: true }))
      .rejects.toThrow(/has not been issued/)
  })
})

describe('🔴 GSTR-1 finally has a cdnr section', () => {
  it('reports the credit note against its original invoice', async () => {
    const inv = await invoice()
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-10', reason: 'Rate renegotiated', taxableValue: '10000',
    })

    const r = await buildGstr1(ctx.companyId, new Date('2026-06-01'), new Date('2026-06-30T23:59:59Z'), 'Jun-2026')
    const row = r.creditNotes.find((c) => c.number === note.number)!
    expect(row).toBeTruthy()
    // the original invoice number is what makes the row matchable at the other end
    expect(row.againstInvoice).toBe(inv.number)
    expect(row.reason).toBe('Rate renegotiated')
    expect(row.taxableValue.toString()).toBe('10000')
  })
})

describe('🔴 past the s.34(2) deadline', () => {
  it('still issues the note, and says the GST cannot be recovered', async () => {
    const inv = await invoice()   // dated 1 May 2026 → deadline 30 Nov 2027

    const late = await previewCreditNote(ctx, {
      invoiceId: inv.id, date: '2027-12-15', full: true,
    })
    expect(late.gstAdjustable).toBe(false)
    expect(late.warnings.join(' ')).toMatch(/cannot be recovered/)

    const inTime = await previewCreditNote(ctx, { invoiceId: inv.id, date: '2026-07-01', full: true })
    expect(inTime.gstAdjustable).toBe(true)
    expect(inTime.warnings).toEqual([])
  })
})
