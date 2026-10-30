import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { archivedDocument } from '@/server/services/storage/document-archive'
import { trialBalance } from '@/server/services/reports/statements'
import type { RequestContext } from '@/server/context'

/**
 * docs/82 §5 — what an unregistered entity actually issues.
 *
 * 🔴 Not a tax invoice at 0%. A document headed "Tax Invoice" carrying a GSTIN field, from a
 * person with no GSTIN, is wrong on its face under rule 46 — and rule 49 prescribes a different
 * document for exactly this supplier.
 */

const prisma = new PrismaClient()
let ctxB: RequestContext
let customerId = ''
let invoiceId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  const ctxA: RequestContext = { userId: user.id, companyId: a.id, role: 'OWNER' }

  const b = await createCompany(ctxA, {
    legalName: 'ADPEDIA DIGITAL SOLUTIONS', constitution: 'PROPRIETORSHIP',
    /**
     * 🔴 The constitution here is docs/82's working assumption, NOT a statement about the real
     * entity — nobody has confirmed whether it is a proprietorship, a partnership or an LLP,
     * and that decides which PAN is valid (P against F), which equity section it gets, and
     * whose return its income lands in. The signatory below is free text and prints whatever
     * the person signs as; it does not establish a legal form, and nothing here should be read
     * as though it did. The firm equity section is covered in `tests/company-chart.test.ts`.
     */
    pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'ADS',
    address: { line1: 'Thommana', city: 'Thrissur', pincode: '680683' },
    signatoryName: 'Shinelal C P', signatoryDesignation: 'Managing Partner',
  })
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }

  customerId = (await prisma.customer.create({ data: {
    companyId: b.id, name: 'A client of the proprietor', country: 'IN', stateCode: '32',
    customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

const bill = (rate: string) => createInvoice(ctxB, {
  customerId, date: '2026-10-01',
  lines: [{ description: 'Freelance work', sacCode: '998314', quantity: '1', rate: '40000', gstRatePct: rate }],
})

describe('an unregistered entity issues a bill of supply', () => {
  it('🔴 refuses to charge GST at all, citing s.32(1)', async () => {
    await expect(bill('18')).rejects.toThrow(/not registered for GST|s\.32\(1\)/)
  })

  it('numbers it from its own series, not the tax-invoice one', async () => {
    const sent = await sendInvoice(ctxB, (await bill('0')).id)
    invoiceId = sent.id
    expect(sent.docType).toBe('BILL_OF_SUPPLY')
    expect(sent.number).toBe('ADSB/26-27/0001')
    expect(Number(sent.grandTotal)).toBeCloseTo(40000, 2)
  })

  it('🔴 posts no output tax, so the books agree with the document', async () => {
    const taxLines = await prisma.journalLine.findMany({
      where: {
        journalEntry: { companyId: ctxB.companyId },
        account: { code: { in: ['2110', '2120', '2130'] } },
      },
    })
    expect(taxLines).toEqual([])
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
  })

  it('🔴 renders as a bill of supply, not as a tax invoice', async () => {
    const html = await renderInvoiceHtml(ctxB.companyId, invoiceId)

    // the sheet carries the mode that hides the supplier GSTIN and every tax row
    expect(html).toMatch(/class="sheet [^"]*doc-bos/)
    // the heading the CSS reveals, and the reason a recipient sees no tax
    expect(html).toContain('Bill of Supply')
    expect(html).toContain('Not registered under GST')
    // rule 49(d) keeps the RECIPIENT's GSTIN; only the supplier's is suppressed
    // 🔴 the supplier's whole particulars block is REMOVED, not hidden: rule 49 asks a bill of
    // supply for name and address only, and text hidden by CSS still travels inside the PDF
    expect(html).not.toContain('supplier-gstin')
    expect(html).not.toMatch(/class="lbl">PAN/)
  })

  /**
   * 🔴 Everything below was found by rendering the document and LOOKING at it, which is the
   * only way any of it would have turned up — every assertion in this file passed while all
   * four were live. It is the lesson handover §6 keeps recording, met again.
   */
  it('🔴 carries this entity’s own identity, not the first company’s', async () => {
    const html = await renderInvoiceHtml(ctxB.companyId, invoiceId)

    // the letterhead: its own name, because it has no logo of its own. `Company.logoUrl` was a
    // field nothing read, so every document of every entity wore Adpedia's letterhead.
    expect(html).toContain('ADPEDIA DIGITAL SOLUTIONS</div>')
    expect(html).not.toContain('adpedia-logo')

    // 🔴 `bank.swift` was the one payment field the renderer never bound, so the template's own
    // AXISINBB printed here — telling this proprietor's client to remit to Adpedia's bank.
    expect(html).not.toContain('AXISINBB')

    // a proprietorship has no CIN, and the row printed its label with nothing after it
    expect(html).not.toMatch(/class="lbl">CIN/)
    expect(html).not.toMatch(/class="lbl">PAN/)

    // 🔴 and who signed it, as what. The template printed a generic "Authorised Signatory" and
    // `Company` carried only a signature image — a firm's managing partner and a company's
    // director are not the same thing to a recipient or to an assessment.
    expect(html).toContain('Shinelal C P')
    expect(html).toContain('Managing Partner')

    // 🔴 and NOT the other entity's identifiers, which the footer printed as literal text
    expect(html).not.toContain('U92190KL2021PTC068241')
    expect(html).not.toContain('32AAUCA9985H1ZX')
    // name and address only — the footer repeats no identifiers on this document
    expect(html).not.toContain('AAAPA1234A')
    expect(html).toContain('ADPEDIA DIGITAL SOLUTIONS')
    expect(html).toContain('Thommana')

    // and the title is what a saved file and the PDF's metadata report
    expect(html).toContain('<title>Bill of Supply — ADPEDIA DIGITAL SOLUTIONS</title>')
  })

  /**
   * 🔴 docs/59 — the archive is keyed by kind, and the lookup has an allowlist of kinds. Filed
   * as a TAX_INVOICE a bill of supply would be indistinguishable later from a document this
   * entity may not issue; missing from the allowlist it would be invisible, and every bill of
   * supply would carry "no copy of this invoice as it was issued" for ever.
   */
  it('🔴 is archived as a bill of supply, and found again as one', async () => {
    const archived = await archivedDocument(ctxB.companyId, 'Invoice', invoiceId)

    expect(archived, 'nothing on file — the docs/59 banner would show for ever').toBeTruthy()
    expect(archived!.kind).toBe('BILL_OF_SUPPLY')
  })
})
