import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { htmlToPdf, closePdfBrowser, pdfFilename } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, kerala = '', dubai = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  kerala = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15,
    billingAddress: { line1: '36/3460-A, M G Road', city: 'Thrissur', state: 'Kerala', pincode: '680001', country: 'India' },
  } })).id
  dubai = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Nuvé Holdings FZ-LLC', country: 'AE', stateCode: null, customerType: 'EXPORT',
    paymentTermDays: 30, currency: 'USD',
    billingAddress: { line1: 'Office 1204, Business Central Towers', city: 'Dubai', country: 'United Arab Emirates' },
  } })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const LINES = [
  { description: 'Staff augmentation — software development resource', sacCode: '998314', quantity: '1', rate: '70000', gstRatePct: '18' },
  { description: 'UI/UX design revisions', sacCode: '998391', quantity: '2', rate: '7500', gstRatePct: '18' },
]

describe('invoice document rendering', () => {
  it('renders an intra-state invoice with the real figures', async () => {
    const draft = await createInvoice(ctx, { customerId: kerala, date: '2026-09-30', tdsSection: '194J', customerRef: 'CLICK/PO/2026/14', lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)

    expect(html).toContain('mode-intra')
    expect(html).toContain('tds-194j')
    expect(html).toContain(inv.number)
    expect(html).toContain('ADPEDIA FILMS PRIVATE LIMITED')
    expect(html).toContain('32AAUCA9985H1ZX')              // supplier GSTIN
    expect(html).toContain('U92190KL2021PTC068241')        // CIN — Companies Act s.12(3)(c)
    expect(html).toContain('VIII/318')                     // the corrected address
    expect(html).toContain('Click AR Business Private Limited')
    expect(html).toContain('32AAKCC9890P1ZS')              // customer GSTIN
    expect(html).toContain('Kerala (32)')                  // place of supply
    expect(html).toContain('1,00,300.00')                  // Indian grouping
    expect(html).toContain('7,650.00')                     // CGST and SGST
    expect(html).toContain('Indian Rupees One Lakh Three Hundred Only')
    expect(html).toContain('921020015185413')              // bank account
    expect(html).toContain('UTIB0002174')
    expect(html).toContain('Staff augmentation')
    expect(html).toContain('Authorised Signatory')
    // the signature is embedded, not linked — a linked one never reaches the PDF
    expect(html).toContain('data:image/png;base64,')
  })

  it('hides the SAC column while still capturing the codes', async () => {
    const draft = await createInvoice(ctx, { customerId: kerala, date: '2026-09-30', lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)
    expect(html).toContain('hide-sac')                     // print setting is off
    const stored = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id, position: 1 } })
    expect(stored.sacCode).toBe('998314')                  // but GSTR-1 still has it
  })

  it('renders an export invoice zero-rated, with the LUT guard visible when none is on file', async () => {
    const inv = await createInvoice(ctx, { customerId: dubai, date: '2026-09-30', lines: LINES })
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)

    expect(html).toContain('mode-export')
    expect(html).toContain('tds-none')
    expect(html).toContain('lut-expired')                  // no LUT for FY 2026-27
    expect(html).toContain('Nuvé Holdings FZ-LLC')
    expect(html).toContain('Not applicable — overseas recipient')
    expect(html).toContain('Outside India')
    // the lines total 85,000 and the invoice is in USD, so the words follow the currency
    expect(html).toContain('US Dollars Eighty Five Thousand Only')
    expect(html).not.toContain('Indian Rupees')
    expect(html).not.toContain('Original for Recipient')    // it is still a draft
    expect(html).toContain('Draft — not issued')
  })

  it('produces a complete, self-consistent HTML document', async () => {
    const draft = await createInvoice(ctx, { customerId: kerala, date: '2026-09-30', lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    expect(html).toContain('size: A4')
    // none of the template's placeholder sample data may survive into a real document
    for (const placeholder of [
      'Prime &mdash; Website Development',
      'CLICK/PO/2026/14',
      'Nuv\u00e9 Properties Pvt Ltd',
      '3 of 4',
      'Unit 704, Lotus Corporate Park',
    ]) {
      expect(html, `leftover placeholder: ${placeholder}`).not.toContain(placeholder)
    }
    // and every bound field must have been filled
    expect(html).not.toMatch(/data-bind="invoice\.number">\s*</)
  })
})

describe('PDF output', () => {
  it('🔴 produces a real PDF, not HTML with a .pdf name', async () => {
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })).id)

    const pdf = await htmlToPdf(await renderInvoiceHtml(ctx.companyId, inv.id))

    // the magic bytes are the whole point — a mislabelled file opens as garbage on the
    // client's phone, and they do not come back to tell you
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.subarray(-6).toString('ascii')).toMatch(/%%EOF/)
    expect(pdf.length).toBeGreaterThan(10_000)   // a blank page is ~1KB
  }, 60_000)

  it('renders the whole invoice on one A4 page', async () => {
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })).id)
    const pdf = await htmlToPdf(await renderInvoiceHtml(ctx.companyId, inv.id))

    // one /Type /Page object: a two-page tax invoice means the layout has broken and the
    // signature block has fallen onto a sheet of its own
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    expect(pages).toBe(1)
  }, 60_000)

  it('renders an export invoice too, where the layout differs', async () => {
    // left as a DRAFT on purpose: sending it is correctly refused because FY 2026-27 has
    // no LUT on file, and defeating that guard to make a render test pass would be the
    // wrong trade entirely
    const draft = await createInvoice(ctx, {
      customerId: dubai, date: '2026-09-30',
      lines: [{ description: 'Software development', sacCode: '998314', quantity: '1', rate: '2000', gstRatePct: '0' }],
    })
    const pdf = await htmlToPdf(await renderInvoiceHtml(ctx.companyId, draft.id))
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    expect(pages).toBe(1)
  }, 60_000)

  it('reuses one browser across renders instead of launching per request', async () => {
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })).id)
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)

    await htmlToPdf(html)                       // pays the cold-launch cost
    const t0 = Date.now()
    await Promise.all([htmlToPdf(html), htmlToPdf(html), htmlToPdf(html)])
    // three concurrent renders on a warm browser; a cold launch each would be ~3s+
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 90_000)

  it('🔴 embeds the logo and signature rather than linking them', async () => {
    // A root-relative "/brand/…" resolves over HTTP and silently fails under setContent(),
    // where there is no base URL. Nothing errors — the invoice is just issued unbranded and
    // unsigned, and the first anyone knows is the client receiving it.
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })).id)
    const html = await renderInvoiceHtml(ctx.companyId, inv.id)

    expect(html).not.toContain('src="/brand/')
    expect(html).not.toContain('src="assets/')
    expect(html).toContain('data:image/svg+xml;base64,')   // logo, header and footer
    expect(html).toContain('data:image/png;base64,')       // signature

    // and the bytes actually reach the PDF
    const pdf = await htmlToPdf(html)
    expect(pdf.length).toBeGreaterThan(50_000)
  }, 60_000)

  it('🔴 labels the money columns in the invoice\u2019s own currency', async () => {
    // the template hard-codes "(₹)". On a USD export that gives a document whose header
    // says rupees and whose total says USD — the kind of contradiction a client's bank
    // queries before releasing an inward remittance
    const draft = await createInvoice(ctx, {
      customerId: dubai, date: '2026-09-30',
      lines: [{ description: 'Brand film', sacCode: '998387', quantity: '1', rate: '6500', gstRatePct: '0' }],
    })
    const html = await renderInvoiceHtml(ctx.companyId, draft.id)
    expect(html).toContain('Rate (USD)')
    expect(html).toContain('Taxable Value (USD)')
    expect(html).not.toContain('Rate (₹)')

    // and a domestic invoice still says rupees
    const inr = await createInvoice(ctx, { customerId: kerala, date: '2026-09-30', lines: LINES })
    expect(await renderInvoiceHtml(ctx.companyId, inr.id)).toContain('Rate (₹)')
  })

  it('🔴 states the payment term that actually applies to this invoice', async () => {
    // the template said "within 15 days" on every invoice; this customer is on 30-day
    // terms, so the sentence contradicted the due date printed two inches above it
    const draft = await createInvoice(ctx, {
      customerId: dubai, date: '2026-09-30',
      lines: [{ description: 'Brand film', sacCode: '998387', quantity: '1', rate: '6500', gstRatePct: '0' }],
    })
    const html = await renderInvoiceHtml(ctx.companyId, draft.id)
    const days = Math.round(
      (new Date('2026-10-30').getTime() - new Date('2026-09-30').getTime()) / 86_400_000)
    expect(html).toContain(`Payment due within ${days} days`)
    expect(html).not.toContain('Payment due within 15 days of the invoice date')
  })

  it('🔴 an issued invoice does not change when the customer record is corrected', async () => {
    // Rule 46 makes a tax invoice a fixed document: the copy the client holds and the copy
    // we can reproduce must say the same thing. This is exactly the defect found in
    // Adpedia's own historical invoices — VIII/308 on the paper, VIII/318 on the register.
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })).id)
    const before = await renderInvoiceHtml(ctx.companyId, inv.id)
    expect(before).toContain('36/3460-A, M G Road')
    expect(before).toContain('32AAKCC9890P1ZS')

    await prisma.customer.update({
      where: { id: kerala },
      data: {
        name: 'Click AR Business Private Limited (Renamed)',
        gstin: '27AAKCC9890P1ZT',
        billingAddress: { line1: 'Somewhere else entirely', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', country: 'India' },
      },
    })

    const after = await renderInvoiceHtml(ctx.companyId, inv.id)
    expect(after).toContain('36/3460-A, M G Road')          // the address as issued
    expect(after).toContain('32AAKCC9890P1ZS')              // the GSTIN reported in GSTR-1
    expect(after).not.toContain('Somewhere else entirely')
    expect(after).not.toContain('(Renamed)')
  })

  it('a DRAFT still follows the live customer, because nothing has been issued', async () => {
    const draft = await createInvoice(ctx, {
      customerId: kerala, date: '2026-09-30', tdsSection: '194J', lines: LINES,
    })
    const html = await renderInvoiceHtml(ctx.companyId, draft.id)
    expect(html).toContain('(Renamed)')
  })

  it('names the file so it can be found again', () => {
    expect(pdfFilename('ADP/26-27/0026')).toBe('ADP-26-27-0026.pdf')
    expect(pdfFilename('ADPX/26-27/0001')).toBe('ADPX-26-27-0001.pdf')
  })
})
