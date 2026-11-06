import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote, previewCreditNote } from '@/server/services/invoicing/credit-note'
import { renderCreditNoteHtml } from '@/server/services/invoicing/render-credit-note'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { accountLedger } from '@/server/services/reports/ledger'
import { trialBalance } from '@/server/services/reports/statements'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, kerala = '', dubai = ''
const FROM = new Date('2026-04-01')

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
    companyId: company.id, name: 'Nuvé Holdings FZ-LLC', country: 'AE', stateCode: null,
    customerType: 'EXPORT', paymentTermDays: 30, currency: 'USD',
    billingAddress: { line1: 'Office 1204, Business Central Towers', city: 'Dubai', country: 'United Arab Emirates' },
  } })).id

  // exports are blocked without a current LUT, by design
  await prisma.companyLut.create({ data: {
    companyId: company.id, arn: 'AD320326TEST001', fyLabel: '2026-27',
    validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31'),
  } })

  // the s.34(2) test dates a note into the following year, which needs its own FY and its
  // own credit-note series — the system refuses to post or number outside one
  const next = await prisma.financialYear.create({ data: {
    companyId: company.id, label: '2027-28',
    startsOn: new Date('2027-04-01'), endsOn: new Date('2028-03-31T23:59:59Z'),
  } })
  await prisma.documentSeries.create({ data: {
    companyId: company.id, financialYearId: next.id, docType: 'CREDIT_NOTE',
    prefix: 'ADPC', pattern: 'ADPC/{FY}/{SEQ:4}', nextSeq: 1,
  } })
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const LINES = [
  { description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' },
]

// docs/91 — a rate for the exports; a rupee invoice ignores it
async function issuedInvoice(customerId: string, date: string, lines = LINES) {
  return sendInvoice(ctx, (await createInvoice(ctx, { customerId, date, fxRate: '84', lines })).id)
}

describe('the credit note as a document — rule 53(1A)', () => {
  let noteId = '', invNumber = ''

  it('renders with everything the rule requires', async () => {
    const inv = await issuedInvoice(kerala, '2026-05-10')
    invNumber = inv.number
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-01', taxableValue: '20000',
      reason: 'Rate revised after delivery, per the client note of 28 May',
    })
    noteId = note.id

    const html = await renderCreditNoteHtml(ctx.companyId, note.id)

    expect(html).toContain('Credit Note')                      // (b) nature of the document
    expect(html).toContain(note.number)                        // (c) serial number
    expect(html).toContain('01 Jun 2026')                      // (d) date of issue
    expect(html).toContain('ADPEDIA FILMS PRIVATE LIMITED')    // (a) supplier
    expect(html).toContain('32AAUCA9985H1ZX')
    expect(html).toContain('VIII/318')                         // the corrected address
    expect(html).toContain('Click AR Business Private Limited')// (e) recipient
    expect(html).toContain('32AAKCC9890P1ZS')
    // 🔴 (f) the invoice it relates to, number AND date — without them the client's accounts
    // team cannot allocate the credit
    expect(html).toContain(inv.number)
    expect(html).toContain('10 May 2026')
    expect(html).toContain('20,000.00')                        // (g) value credited
    expect(html).toContain('1,800.00')                         // CGST and SGST at 9%
    expect(html).toContain('Authorised Signatory')             // (h)
    expect(html).toContain('Section 34(1)')
  })

  it('shows the tax head-wise, and only the heads that apply', async () => {
    const html = await renderCreditNoteHtml(ctx.companyId, noteId)
    expect(html).toContain('mode-intra')
    expect(html).toContain('gst-adjusted')
    // the IGST row exists in the template but the mode class keeps it off a Kerala note —
    // the same !important trap the invoice hit in docs/33
    expect(html).toMatch(/\.gst-adjusted\.mode-inter\s+\.r-igst\{\s*display:flex !important/)
  })

  it('embeds the logo and signature rather than linking them', async () => {
    // a linked asset silently never reaches the PDF, and the note goes out unbranded
    const html = await renderCreditNoteHtml(ctx.companyId, noteId)
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('data:image/svg+xml;base64,')
    expect(html).not.toContain('src="assets/')
  })

  it('🔴 names the company above the signature, not the template placeholder', async () => {
    // bound twice — supplier block and signature line — and only the first was substituted
    const html = await renderCreditNoteHtml(ctx.companyId, noteId)
    const matches = html.match(/data-bind="company\.legalName">([^<]*)/g) ?? []
    expect(matches.length).toBeGreaterThan(1)
    for (const m of matches) expect(m).toContain('ADPEDIA FILMS PRIVATE LIMITED')
  })

  it('says it does not cancel the invoice', async () => {
    const html = await renderCreditNoteHtml(ctx.companyId, noteId)
    expect(html).toContain(`The amount payable against invoice ${invNumber} is reduced`)
    expect(html).toContain('does not cancel it')
  })

  it('renders to a real PDF', async () => {
    const pdf = await htmlToPdf(await renderCreditNoteHtml(ctx.companyId, noteId))
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(20_000)
  }, 60_000)
})

describe('🔴 the recipient is the one on the invoice, not the one on file today', () => {
  it('keeps the address as issued when the customer is later corrected', async () => {
    const inv = await issuedInvoice(kerala, '2026-05-20')
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-02', taxableValue: '5000', reason: 'Partial credit for late delivery',
    })

    await prisma.customer.update({
      where: { id: kerala },
      data: { billingAddress: { line1: 'New Tower, Sahodaran Ayyappan Road', city: 'Kochi', state: 'Kerala', pincode: '682016', country: 'India' } },
    })

    const html = await renderCreditNoteHtml(ctx.companyId, note.id)
    expect(html).toContain('36/3460-A, M G Road')   // as issued
    expect(html).not.toContain('New Tower')
  })
})

describe('🔴 a credit note past the s.34(2) deadline recovers no GST', () => {
  let commercialId = ''

  it('credits the client the same gross, with the tax shown as not credited', async () => {
    // supply in FY 2026-27, so output tax may be adjusted only until 30 Nov 2027
    const inv = await issuedInvoice(kerala, '2026-06-15')
    const p = await previewCreditNote(ctx, { invoiceId: inv.id, date: '2027-12-01', taxableValue: '10000' })

    expect(p.gstAdjustable).toBe(false)
    expect(p.cgst.toString()).toBe('0')
    expect(p.sgst.toString()).toBe('0')
    expect(p.taxNotAdjusted.toFixed(2)).toBe('1800.00')
    // the client is still credited 11,800 — only its composition changes
    expect(p.grandTotal.toFixed(2)).toBe('11800.00')
    expect(p.warnings.join(' ')).toMatch(/commercial credit note/)

    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2027-12-01', taxableValue: '10000',
      reason: 'Goodwill credit agreed after the GST deadline',
    })
    commercialId = note.id
    expect(note.gstAdjusted).toBe(false)
    expect(note.taxNotAdjusted.toString()).toBe('1800')
  })

  it('🔴 does not debit the output tax accounts', async () => {
    // the books must not claim a reduction the return cannot support
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.companyId, sourceType: 'CREDIT_NOTE', sourceId: commercialId },
      include: { lines: { include: { account: true } } },
    })
    const codes = entry.lines.map((l) => l.account.code)
    expect(codes).not.toContain('2110')
    expect(codes).not.toContain('2120')

    // the whole gross comes off revenue instead — what the company actually gave back
    const revenue = entry.lines.find((l) => l.account.code === '4010')!
    expect(revenue.debit.toString()).toBe('11800')
    expect(revenue.narration).toMatch(/cannot be recovered/)
    expect((await trialBalance(ctx, { from: FROM, to: new Date('2028-03-31') })).balanced).toBe(true)
  })

  it('🔴 is left out of the GSTR-1 credit-note table, and says so', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2027-10-01'), new Date('2027-12-31T23:59:59Z'), '2027-Q3')
    expect(r.creditNotes).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/commercial credit note/)
  })

  it('says on its face that no GST is credited', async () => {
    const html = await renderCreditNoteHtml(ctx.companyId, commercialId)
    expect(html).toContain('gst-commercial')
    // 🔴 the declaration has to name the invoice it is talking about. It quoted the
    // template's placeholder, so the one legally-loaded sentence on the page referred to a
    // different invoice than the document itself.
    const commercial = await prisma.creditNote.findUniqueOrThrow({
      where: { id: commercialId }, include: { invoice: { select: { number: true } } },
    })
    expect(html).toMatch(new RegExp(`against invoice <span data-bind="invoice\\.number">${commercial.invoice!.number.replace(/\//g, '\\/')}`))
    expect(html).toContain('GST not credited')
    expect(html).toContain('1,800.00')
    // 🔴 30 November, not 1 December. The deadline is an end-of-day UTC marker, and
    // formatting it in IST pushed it a day forward — on the one line where the date is the
    // whole point of the sentence.
    // (the note's own date really is 01 Dec 2027, so the deadline is asserted in place)
    expect(html).toMatch(/expired on\s*<span data-bind="note\.deadline">30 Nov 2027/)
    expect(html).toContain('not reported in GSTR-1')
  })

  it('still reduces what the client owes', async () => {
    const ar = await accountLedger(ctx, '1100', { from: FROM, to: new Date('2028-03-31') })
    expect(ar!.lines.some((l) => l.narration.includes('Goodwill credit') && l.credit.toString() === '11800')).toBe(true)
  })
})

describe('an export credit note', () => {
  it('carries the invoice currency and no tax', async () => {
    const inv = await issuedInvoice(dubai, '2026-07-01', [
      { description: 'Brand film — milestone 1', sacCode: '998387', quantity: '1', rate: '5000', gstRatePct: '0' },
    ])
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-07-20', taxableValue: '500', reason: 'Scope reduced by one deliverable',
    })

    const html = await renderCreditNoteHtml(ctx.companyId, note.id)
    expect(html).toContain('mode-export')
    // 🔴 the money column must carry the invoice's own currency — a USD credit in a document
    // headed "(₹)" is what a client's bank queries
    expect(html).toContain('Value Credited (USD)')
    expect(html).toContain('USD 500.00')
    expect(html).toContain('Not applicable — overseas recipient')
    expect(html).toContain('United Arab Emirates')
  })
})
