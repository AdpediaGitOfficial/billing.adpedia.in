import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { eInvoiceApplicability, EINVOICE_THRESHOLD } from '@/server/services/einvoice/applicability'
import { previewEInvoice, registerEInvoice } from '@/server/services/einvoice/register'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let invoiceId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  const customer = await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, defaultTdsSection: '194J',
    billingAddress: { line1: 'Kakkanad', city: 'Ernakulam', pincode: '682030', state: 'Kerala' },
  } })

  const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId: customer.id, date: '2026-09-30', tdsSection: '194J',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
  invoiceId = inv.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 e-invoicing applicability is read from the ledger', () => {
  it('reports Adpedia as far below the ₹5 Cr threshold', async () => {
    const a = await eInvoiceApplicability(ctx)
    expect(a.threshold.toString()).toBe(EINVOICE_THRESHOLD.toString())
    expect(a.applicable).toBe(false)
    expect(a.approaching).toBe(false)
    expect(a.peakTurnover.lt(EINVOICE_THRESHOLD)).toBe(true)
    expect(a.verdict).toMatch(/does not apply/)
  })

  it('measures turnover from invoices raised, not cash collected', async () => {
    // the invoice above is unpaid; turnover must still count it, or a company could cross
    // the threshold on billing and never notice because nobody had paid yet
    const a = await eInvoiceApplicability(ctx)
    expect(a.currentTurnover.toString()).toBe('100000')
  })

  it('excludes GST from turnover — the tax is never the company’s revenue', async () => {
    const a = await eInvoiceApplicability(ctx)
    expect(a.currentTurnover.toString()).toBe('100000')   // not 118000
  })

  it('reports headroom to the threshold', async () => {
    const a = await eInvoiceApplicability(ctx)
    expect(a.headroom.toString()).toBe(EINVOICE_THRESHOLD.minus('100000').toString())
    expect(a.hsn6Required).toBe(false)
  })
})

describe('🔴 the gate refuses to touch the IRP', () => {
  it('will not register an IRN while the company is not liable', async () => {
    await expect(registerEInvoice(ctx, invoiceId)).rejects.toThrow(/does not apply/)
  })

  it('leaves the invoice untouched after the refusal', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(inv.irn).toBeNull()
    expect(inv.ackNo).toBeNull()
    expect(inv.signedQr).toBeNull()
  })
})

describe('the dry run works regardless, which is the point', () => {
  it('validates a real invoice against the IRP schema without contacting it', async () => {
    const { issues, ready, payload } = await previewEInvoice(ctx, invoiceId)
    expect(issues).toEqual([])
    expect(ready).toBe(true)
    expect((payload as { Version: string }).Version).toBe('1.1')
  })

  it('names what would fail, so master data can be fixed before it matters', async () => {
    // a customer with no GSTIN and no PIN is exactly what blocks an invoice on day one
    const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
    const thin = await prisma.customer.create({ data: {
      companyId: company.id, name: 'Walk-in Client', country: 'IN', stateCode: '32',
      customerType: 'B2B', paymentTermDays: 15, billingAddress: { line1: 'Thrissur', city: 'Thrissur' },
    } })
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: thin.id, date: '2026-09-30',
      lines: [{ description: 'Edit', sacCode: '998314', quantity: '1', rate: '5000', gstRatePct: '18' }],
    })).id)

    const { issues, ready } = await previewEInvoice(ctx, inv.id)
    expect(ready).toBe(false)
    expect(issues.map((i) => i.field)).toContain('BuyerDtls.Gstin')
    expect(issues.map((i) => i.field)).toContain('BuyerDtls.Pin')
  })
})
