import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, updateInvoiceDraft, sendInvoice } from '@/server/services/invoicing/invoice'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

/** docs/70 — editing a draft, which until now meant cancelling it and raising another. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', keralaId = '', tamilNaduId = '', usId = ''

const line = (rate: string, description = 'Brand film — production') =>
  [{ description, rate, quantity: '1', gstRatePct: '18' }]

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  const customer = (name: string, country: string, stateCode: string | null, gstin: string | null) =>
    prisma.customer.create({
      data: { companyId, name, country, stateCode, gstin, customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
    })

  keralaId = (await customer('Click AR Business Private Limited', 'IN', '32', '32AAKCC9890P1ZS')).id
  tamilNaduId = (await customer('Madras Media Works', 'IN', '33', '33AAKCC9890P1ZT')).id
  usId = (await customer('Northfield Studios LLC', 'US', null, null)).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('editing a draft', () => {
  it('replaces the lines and re-totals', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-01', lines: line('100000') })
    expect(d.grandTotal.toString()).toBe('118000')

    const after = await updateInvoiceDraft(ctx, d.id, {
      customerId: keralaId, date: '2026-06-01',
      lines: [...line('80000', 'Brand film — production'), ...line('20000', 'Colour grade')],
    })
    expect(after.lines).toHaveLength(2)
    expect(after.grandTotal.toString()).toBe('118000')
    // and the old lines are gone rather than appended to
    expect(await prisma.invoiceLine.count({ where: { invoiceId: d.id } })).toBe(2)
  })

  it('keeps the draft marker, because a draft still has no number', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-02', lines: line('50000') })
    const after = await updateInvoiceDraft(ctx, d.id, { customerId: keralaId, date: '2026-06-03', lines: line('60000') })
    expect(after.number).toBe(d.number)
    expect(after.number.startsWith('DRAFT-')).toBe(true)
    expect(after.seq).toBe(0)
  })

  /**
   * 🔴 Changing the customer changes the document.
   *
   * Tax mode, place of supply, currency and docType all follow from who is being billed. A
   * patch that copied the new customerId over the old one would leave a draft that is
   * internally impossible — an IGST invoice addressed to a Kerala client, or a rupee export.
   */
  it('🔴 recomputes the tax mode, place of supply, currency and document type', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-04', lines: line('100000') })
    expect(d.taxMode).toBe('INTRA')
    expect(d.cgst.toString()).toBe('9000')

    const inter = await updateInvoiceDraft(ctx, d.id, { customerId: tamilNaduId, date: '2026-06-04', lines: line('100000') })
    expect(inter.taxMode).toBe('INTER')
    expect(inter.igst.toString()).toBe('18000')
    expect(inter.cgst.toString()).toBe('0')
    expect(inter.placeOfSupply).toBe('33')

    const exp = await updateInvoiceDraft(ctx, d.id, { customerId: usId, date: '2026-06-04', lines: line('100000') })
    expect(exp.taxMode).toBe('EXPORT')
    expect(exp.docType).toBe('EXPORT_INVOICE')
    expect(exp.placeOfSupply).toBe('96')
    expect(exp.currency).not.toBe('INR')
    expect(exp.igst.toString()).toBe('0')
  })

  /**
   * 🔴 The financial year is re-resolved from the new date.
   *
   * Carried over, a draft moved across 1 April would take its number at send from the series
   * of the year it was created in — out of order, in a year it does not belong to. The number
   * is well-formed and the series is real, so nothing downstream questions it; the gap only
   * appears when somebody reconciles the register.
   */
  it('🔴 moves to the financial year the new date falls in', async () => {
    const fy2627 = await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })
    /**
     * 🔴 Created here rather than skipped if absent. The first version returned early when
     * 2027-28 was missing — and the seed only carries 2025-26 and 2026-27, so it returned
     * early every time. A test that passes by not running is worse than no test: it is a
     * green tick over the exact thing it was written to check.
     */
    const fy2728 = await prisma.financialYear.upsert({
      where: { companyId_label: { companyId, label: '2027-28' } },
      update: {},
      create: {
        companyId, label: '2027-28', status: 'OPEN',
        startsOn: new Date(Date.UTC(2027, 3, 1)), endsOn: new Date(Date.UTC(2028, 2, 31, 23, 59, 59)),
      },
    })

    const d = await createInvoice(ctx, { customerId: keralaId, date: '2027-03-20', lines: line('100000') })
    expect(d.financialYearId).toBe(fy2627.id)

    const moved = await updateInvoiceDraft(ctx, d.id, { customerId: keralaId, date: '2027-04-05', lines: line('100000') })
    expect(moved.financialYearId).toBe(fy2728.id)
  })

  it('🔴 refuses once the invoice has been issued', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-05', lines: line('100000') })
    const sent = await sendInvoice(ctx, d.id)

    await expect(updateInvoiceDraft(ctx, sent.id, { customerId: keralaId, date: '2026-06-05', lines: line('1') }))
      .rejects.toThrow(/has been issued/)
    await expect(updateInvoiceDraft(ctx, sent.id, { customerId: keralaId, date: '2026-06-05', lines: line('1') }))
      .rejects.toThrow(/credit or debit note/)

    // and it is unmoved
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: sent.id } })
    expect(after.grandTotal.toString()).toBe('118000')
  })

  it('refuses an invoice with no lines', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-06', lines: line('1000') })
    await expect(updateInvoiceDraft(ctx, d.id, { customerId: keralaId, date: '2026-06-06', lines: [] }))
      .rejects.toThrow(/at least one line/)
  })

  it('records what changed, so the edit is not invisible', async () => {
    const d = await createInvoice(ctx, { customerId: keralaId, date: '2026-06-07', lines: line('10000') })
    await updateInvoiceDraft(ctx, d.id, { customerId: keralaId, date: '2026-06-07', lines: line('25000') })

    const log = await prisma.auditLog.findFirst({
      where: { entity: 'Invoice', entityId: d.id, action: 'UPDATE' }, orderBy: { at: 'desc' },
    })
    expect(log).not.toBeNull()
    expect(JSON.stringify(log!.before)).toContain('11800')
    expect(JSON.stringify(log!.after)).toContain('29500')
  })
})
