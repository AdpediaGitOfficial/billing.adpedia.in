import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import QRCode from 'qrcode'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { renderInvoiceHtml, isRealIrp } from '@/server/services/invoicing/render'
import { registerEInvoice } from '@/server/services/einvoice/register'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

/** docs/75 — the IRN and its QR on the document, and the mock that must never reach one. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = ''

async function anInvoice(date = '2026-07-01') {
  const inv = await createInvoice(ctx, {
    customerId, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', rate: '100000', quantity: '1', gstRatePct: '18' }],
  })
  return sendInvoice(ctx, inv.id)
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  customerId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15,
      billingAddress: { line1: 'Kakkanad', city: 'Ernakulam', pincode: '682030', state: 'Kerala' } },
  })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 an invoice that is not an e-invoice', () => {
  it('carries no IRN block at all, rather than an empty one', async () => {
    const inv = await anInvoice('2026-07-01')
    const html = await renderInvoiceHtml(companyId, inv.id)
    expect(html).not.toContain('class="einvoice"')
    expect(html).not.toMatch(/>IRN</)
    // and the rest of the document is unaffected
    expect(html).toContain(inv.number)
    expect(html).toContain('Authorised Signatory')
  })
})

/**
 * 🔴 The mock writes into the same four columns as a real IRP, with an IRN of the right shape
 * and a `signedQr` that is base64 of `{"mock":true,…}`. Printed, it would look exactly like an
 * e-invoice and verify as nothing — a forgery nobody set out to make.
 */
describe('🔴 an invoice registered against the mock', () => {
  it('records which IRP produced the IRN', async () => {
    /**
     * Registration is gated on turnover and on `EINVOICE_ENABLED`, which is right — so the
     * mock path is reached here by crossing the threshold properly rather than by reaching
     * past the gate. One large invoice does it.
     */
    const big = await createInvoice(ctx, {
      customerId, date: '2026-07-02',
      lines: [{ description: 'Staff augmentation', sacCode: '998314', rate: '60000000', quantity: '1', gstRatePct: '18' }],
    })
    await sendInvoice(ctx, big.id)
    process.env.EINVOICE_ENABLED = 'true'

    const inv = await anInvoice('2026-07-05')
    await registerEInvoice(ctx, inv.id)
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.irn).toBeTruthy()
    expect(after.irpSource).toBe('MOCK — not a real IRP')
    expect(isRealIrp(after.irpSource)).toBe(false)
  })

  it('prints neither the IRN nor a QR', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { companyId, irn: { not: null }, irpSource: 'MOCK — not a real IRP' },
    })
    const html = await renderInvoiceHtml(companyId, inv.id)
    expect(html).not.toContain('class="einvoice"')
    expect(html).not.toContain(inv.irn!)
    /**
     * And specifically not an encoding of the MOCK's signed payload. `data:image/png` alone
     * proves nothing here — the logo and the signature are inlined as data URIs too
     * (docs/31), so the first version of this assertion failed on the company's own logo.
     */
    const wouldBe = await QRCode.toDataURL(inv.signedQr!, { errorCorrectionLevel: 'M', margin: 0, width: 360 })
    expect(html).not.toContain(wouldBe)
  })

  /** The allowlist is the point: an adapter added later and forgotten must not print. */
  it('treats an unknown source as not real', () => {
    expect(isRealIrp(null)).toBe(false)
    expect(isRealIrp('')).toBe(false)
    expect(isRealIrp('SOME NEW PROVIDER')).toBe(false)
    expect(isRealIrp('LIVE')).toBe(true)
  })
})

describe('an invoice with a real IRN', () => {
  const SIGNED_QR = 'eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoie1wiU2VsbGVyR3N0aW5cIjpcIjMyQUFVQ0E5OTg1SDFaWFwifSJ9.c2lnbmF0dXJl'

  it('🔴 prints the QR from the IRP’s own payload, verbatim', async () => {
    const inv = await anInvoice('2026-07-03')
    await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        irn: 'a'.repeat(64), ackNo: '112410000123456', ackDate: new Date('2026-07-03T10:30:00Z'),
        signedQr: SIGNED_QR, irpSource: 'LIVE',
      },
    })

    const html = await renderInvoiceHtml(companyId, inv.id)
    expect(html).toContain('class="einvoice"')
    expect(html).toContain('a'.repeat(64))
    expect(html).toContain('112410000123456')

    // 🔴 the image is an encoding of signedQr and of nothing else — not of the invoice's
    // particulars, which would scan, look official and have been signed by nobody
    const expected = await QRCode.toDataURL(SIGNED_QR, { errorCorrectionLevel: 'M', margin: 0, width: 360 })
    expect(html).toContain(expected)
  })

  it('still prints nothing when the IRN is there and the signed QR is not', async () => {
    const inv = await anInvoice('2026-07-04')
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { irn: 'b'.repeat(64), ackNo: '1', ackDate: new Date(), signedQr: null, irpSource: 'LIVE' },
    })
    const html = await renderInvoiceHtml(companyId, inv.id)
    expect(html).not.toContain('class="einvoice"')
  })
})
