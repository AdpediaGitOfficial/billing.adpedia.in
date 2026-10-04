import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { createDebitNote } from '@/server/services/invoicing/debit-note'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import { previewNoteAmendment, recordNoteAmendment, listNoteAmendments } from '@/server/services/tax/gst-note-amendment'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { gstr1ToCsv } from '@/server/services/tax/gst-export'
import { accountLedger } from '@/server/services/reports/ledger'
import { trialBalance } from '@/server/services/reports/statements'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = ''
let creditNoteId = '', debitNoteId = '', oldCreditNoteId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const balance = async (code: string) => (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

const raise = async (date: string, rate = '100000') =>
  sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }],
  })).id)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  customerId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })).id

  const inv = await raise('2026-05-10')
  creditNoteId = (await createCreditNote(ctx, {
    invoiceId: inv.id, date: '2026-06-20', taxableValue: '20000', reason: 'Scope reduced by agreement',
  })).id
  debitNoteId = (await createDebitNote(ctx, {
    invoiceId: inv.id, date: '2026-06-25', taxableValue: '5000', reason: 'Extra day of shooting',
  })).id

  // the GSTR-1 that reported them
  await recordGstFiling(ctx, { returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-13' })
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 amending a note already filed', () => {
  it('posts only the difference, dated in the amendment period', async () => {
    const cgstBefore = await balance('2110')

    const p = await previewNoteAmendment(ctx, {
      noteId: creditNoteId, date: '2026-08-15', taxableValue: '30000',
      reason: 'The agreed reduction was ₹30,000, not ₹20,000',
    })
    expect(p.originalPeriod).toBe('2026-Q1')
    expect(p.amendmentPeriod).toBe('2026-Q2')
    expect(p.delta.revenue.toFixed(2)).toBe('10000.00')
    expect(p.refusal).toBeNull()

    await recordNoteAmendment(ctx, {
      noteId: creditNoteId, date: '2026-08-15', taxableValue: '30000',
      reason: 'The agreed reduction was ₹30,000, not ₹20,000',
    })

    // a credit note DEBITS output tax; amending it upward debits ₹900 more
    expect(Number(cgstBefore) - Number(await balance('2110'))).toBeCloseTo(900, 2)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('starts the next amendment from the corrected figures, not the original', async () => {
    const p = await previewNoteAmendment(ctx, {
      noteId: creditNoteId, date: '2026-09-01', taxableValue: '30000', reason: 'No change at all',
    })
    expect(p.original.taxableValue.toFixed(2)).toBe('30000.00')
    expect(p.changed).toEqual([])
    await expect(recordNoteAmendment(ctx, {
      noteId: creditNoteId, date: '2026-09-01', taxableValue: '30000', reason: 'No change at all',
    })).rejects.toThrow(/Nothing is different/)
  })

  it('does not re-rate the supply from today’s table', async () => {
    const p = await previewNoteAmendment(ctx, {
      noteId: creditNoteId, date: '2026-09-02', taxableValue: '40000', reason: 'A further reduction agreed',
    })
    // 18% as charged: ₹7,200 on ₹40,000, split 9% + 9%
    expect(p.revised.cgst.toFixed(2)).toBe('3600.00')
    expect(p.revised.sgst.toFixed(2)).toBe('3600.00')
    expect(p.revised.igst.toFixed(2)).toBe('0.00')
  })
})

describe('🔴 the deadline a debit note does not have', () => {
  beforeAll(async () => {
    // an invoice from FY 2025-26: s.34(2) for it closed on 30 Nov 2026
    const old = await prisma.invoice.create({
      data: {
        companyId, financialYearId: (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2025-26' } })).id,
        customerId, number: 'ADP/25-26/0099', seq: 99, date: new Date('2025-08-10'),
        dueDate: new Date('2025-08-25'), status: 'SENT', taxMode: 'INTRA', placeOfSupply: '32',
        taxableValue: '100000', cgst: '9000', sgst: '9000', igst: '0', grandTotal: '118000',
        billToGstin: '32AAKCC9890P1ZS', billToStateCode: '32', billToName: 'Click AR Business Private Limited',
      },
    })
    /**
     * 🔴 The note is in a LATER financial year than its invoice, which is what separates the
     * two deadlines — and the whole point of the module.
     *
     * Invoice 10 Aug 2025 (FY 2025-26) → s.34(2) closes 30 Nov 2026.
     * Note 01 May 2026 (FY 2026-27)    → s.37(3) closes 30 Nov 2027.
     *
     * An amendment on 15 Dec 2026 is therefore past s.34(2) and well within s.37(3): the
     * reporting window is open and the relief is closed. With the note in its invoice's own
     * year the two dates coincide and the asymmetry is invisible.
     */
    oldCreditNoteId = (await prisma.creditNote.create({
      data: {
        companyId, financialYearId: (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id,
        invoiceId: old.id,
        number: 'ADPC/26-27/0009', date: new Date('2026-05-01'), reason: 'Scope reduced',
        taxableValue: '10000', cgst: '900', sgst: '900', igst: '0', grandTotal: '11800',
        gstAdjusted: true,
      },
    })).id
  })

  it('🔴 refuses to increase a credit note past the s.34(2) deadline', async () => {
    const p = await previewNoteAmendment(ctx, {
      noteId: oldCreditNoteId, date: '2026-12-15', taxableValue: '25000',
      reason: 'The client says the reduction was larger',
    })
    expect(p.creditDeadline?.toISOString().slice(0, 10)).toBe('2026-11-30')
    expect(p.increasesCredit).toBe(true)
    expect(p.refusal).toMatch(/s\.34\(2\) closed on 2026-11-30/)
    expect(p.refusal).toMatch(/output tax already paid stays paid/)
    expect(p.refusal).toMatch(/commercial credit note/)

    await expect(recordNoteAmendment(ctx, {
      noteId: oldCreditNoteId, date: '2026-12-15', taxableValue: '25000', reason: 'The client says so',
    })).rejects.toThrow(/s\.34\(2\) closed/)
  })

  it('🔴 allows REDUCING it past the deadline, because giving tax back is always open', async () => {
    const p = await previewNoteAmendment(ctx, {
      noteId: oldCreditNoteId, date: '2026-12-15', taxableValue: '4000',
      reason: 'The reduction was smaller than reported',
    })
    expect(p.refusal).toBeNull()
    expect(p.warnings.join(' ')).toMatch(/REDUCES the credit/)
    expect(p.warnings.join(' ')).toMatch(/always open/)
  })

  it('🔴 a DEBIT note has no such deadline, and none is computed for it', async () => {
    const p = await previewNoteAmendment(ctx, {
      noteId: debitNoteId, date: '2026-12-20', taxableValue: '9000',
      reason: 'Two extra days, not one',
    })
    expect(p.noteType).toBe('DEBIT')
    expect(p.creditDeadline).toBeNull()
    expect(p.withinCreditDeadline).toBe(true)
    expect(p.refusal).toBeNull()
  })

  it('🔴 refuses on s.37(3) first when BOTH deadlines have passed', async () => {
    // if the amendment cannot be reported at all, whether s.34(2) would have allowed the
    // relief is moot — one message, and it has to be the one that settles the question
    const p = await previewNoteAmendment(ctx, {
      noteId: oldCreditNoteId, date: '2027-12-15', taxableValue: '25000', reason: 'Far too late',
    })
    expect(p.reportingDeadline.toISOString().slice(0, 10)).toBe('2027-11-30')
    expect(p.refusal).toMatch(/s\.37\(3\)/)
    expect(p.refusal).not.toMatch(/s\.34\(2\)/)
  })
})

describe('🔴 a note that never carried tax', () => {
  it('cannot have tax put on it by an amendment', async () => {
    const inv = await raise('2026-08-11', '50000')
    const commercial = await prisma.creditNote.create({
      data: {
        companyId, financialYearId: inv.financialYearId, invoiceId: inv.id,
        number: 'ADPC/26-27/0098', date: new Date('2026-09-01'), reason: 'Past the deadline',
        taxableValue: '5000', cgst: '0', sgst: '0', igst: '0', grandTotal: '5900',
        gstAdjusted: false, taxNotAdjusted: '900',
      },
    })
    const p = await previewNoteAmendment(ctx, {
      noteId: commercial.id, date: '2026-11-20', taxableValue: '8000', reason: 'The agreed figure was higher',
    })
    // no rate was charged, so nothing is derived — and the warning says what it is
    expect(p.revised.cgst.toFixed(2)).toBe('0.00')
    expect(p.gstAdjusted).toBe(false)
    expect(p.warnings.join(' ')).toMatch(/adjusts no GST/)
    expect(p.refusal).toBeNull()
  })
})

describe('🔴 the return', () => {
  it('reports the amendment in table 9C against the original note', async () => {
    const r = await buildGstr1(companyId, new Date('2026-07-01'), new Date('2026-09-30T23:59:59Z'), '2026-Q2')
    expect(r.amendedNotes.length).toBeGreaterThan(0)
    const row = r.amendedNotes.find((a) => a.originalPeriod === '2026-Q1')!
    expect(row.number).toMatch(/^ADPC\//)
    expect(row.noteType).toBe('CREDIT')
    expect(row.original.taxableValue.toFixed(2)).toBe('20000.00')
    expect(row.revised.taxableValue.toFixed(2)).toBe('30000.00')
    expect(r.warnings.join(' ')).toMatch(/table 9C/)
  })

  it('is its own block in the CSV, beside 9A', async () => {
    const csv = gstr1ToCsv(await buildGstr1(companyId, new Date('2026-07-01'), new Date('2026-09-30T23:59:59Z'), '2026-Q2'))
    expect(csv).toContain('cdnra — Amended credit/debit notes (table 9C)')
    expect(csv).toContain('Originally Filed In')
    expect(csv).toContain('Revised Taxable')
  })

  it('lists what has been amended', async () => {
    const rows = await listNoteAmendments(ctx)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].note.number).toBeTruthy()
  })
})
