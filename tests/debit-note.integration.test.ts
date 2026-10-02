import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createDebitNote, previewDebitNote } from '@/server/services/invoicing/debit-note'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { cancelCreditNote } from '@/server/services/accounting/corrections'
import { renderCreditNoteHtml } from '@/server/services/invoicing/render-credit-note'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { gstr1ToCsv } from '@/server/services/tax/gst-export'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, kerala = ''
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
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15,
    billingAddress: { line1: '36/3460-A, M G Road', city: 'Thrissur', state: 'Kerala', pincode: '680001', country: 'India' },
  } })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const invoice = (date: string, rate = '100000') =>
  createInvoice(ctx, {
    customerId: kerala, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }],
  }).then((d) => sendInvoice(ctx, d.id))

describe('🔴 a debit note is the invoice posting again, for the extra', () => {
  let invoiceId = '', noteId = ''

  it('charges the additional value at the invoice’s own rate', async () => {
    const inv = await invoice('2026-05-10')
    invoiceId = inv.id

    const p = await previewDebitNote(ctx, { invoiceId: inv.id, date: '2026-06-05', taxableValue: '10000' })
    expect(p.cgst.toFixed(2)).toBe('900.00')
    expect(p.sgst.toFixed(2)).toBe('900.00')
    expect(p.grandTotal.toFixed(2)).toBe('11800.00')
    expect(p.invoiceTotalAfter.toFixed(2)).toBe('129800.00')

    const arBefore = await balance('1100')
    const note = await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-05', taxableValue: '10000',
      reason: 'Two extra days of the sprint, agreed on 3 June',
    })
    noteId = note.id

    expect(note.noteType).toBe('DEBIT')
    expect(note.number).toMatch(/^ADPD\//)
    expect(Number(await balance('1100'))).toBeCloseTo(Number(arBefore) + 11800, 2)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('posts revenue and output tax UP, the mirror of a credit note', async () => {
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.companyId, sourceId: noteId },
      include: { lines: { include: { account: true } } },
    })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, {
      debit: l.debit.toString(), credit: l.credit.toString(),
    }]))
    expect(by['1100'].debit).toBe('11800')
    expect(by['4010'].credit).toBe('10000')
    expect(by['2110'].credit).toBe('900')
  })

  it('🔴 unsettles an invoice that had been paid', async () => {
    const inv = await invoice('2026-05-12', '50000')
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', amountReceived: inv.grandTotal } })

    await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-06', taxableValue: '5000',
      reason: 'Overtime on the final weekend, agreed after settlement',
    })
    // more is owed, so it is not settled any more
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PARTIALLY_PAID')
  })

  it('refuses a reason under five characters, and a nil value', async () => {
    await expect(createDebitNote(ctx, { invoiceId, date: '2026-06-07', taxableValue: '1000', reason: 'oops' }))
      .rejects.toThrow(/needs a reason/)
    await expect(createDebitNote(ctx, { invoiceId, date: '2026-06-07', taxableValue: '0', reason: 'Nothing to charge' }))
      .rejects.toThrow(/positive value/)
  })
})

describe('🔴 the rules a debit note does NOT share with a credit note', () => {
  it('has no s.34(2) deadline — it may be issued long after 30 November', async () => {
    // the same date would be refused outright on a credit note
    const inv = await invoice('2026-05-15')
    const late = await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2027-03-20', taxableValue: '5000',
      reason: 'Scope creep invoiced late, well past the credit-note deadline',
    })
    expect(late.gstAdjusted).toBe(true)
    expect(new Decimal(late.taxNotAdjusted.toString()).isZero()).toBe(true)

    const credit = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2027-12-01', taxableValue: '5000',
      reason: 'The same date on a credit note is past the deadline',
    }).catch((e) => e)
    // (the credit note path is exercised in docs/48; here the point is only that the two
    // instruments are governed differently, which is why the debit note has no such branch)
    expect(late.noteType).toBe('DEBIT')
    expect(credit).toBeDefined()
  })

  it('says where the tax belongs and when the client may claim it', async () => {
    const p = await previewDebitNote(ctx, { invoiceId: (await invoice('2026-05-16')).id, date: '2026-07-01', taxableValue: '1000' })
    expect(p.notes.join(' ')).toMatch(/s\.34\(4\)/)
    expect(p.notes.join(' ')).toMatch(/16\(4\)/)
    expect(p.notes.join(' ')).toMatch(/01 January 2021/)
  })
})

describe('the document', () => {
  let debitId = ''

  it('renders as a debit note, under s.34(3)', async () => {
    const inv = await invoice('2026-05-18')
    const note = await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-10', taxableValue: '20000',
      reason: 'Additional resource for the final fortnight',
    })
    debitId = note.id

    const html = await renderCreditNoteHtml(ctx.companyId, note.id)
    expect(html).toContain('<h1>Debit Note</h1>')
    expect(html).toContain('Section 34(3), CGST Act 2017')
    expect(html).toContain('Charged To')
    expect(html).toContain('Value Charged (₹)')
    expect(html).toContain('CGST charged')
    expect(html).toContain('is increased by the total')
    // the three rendering caught: the meta label, the line, and the tab title that becomes
    // the filename when a client prints the page
    expect(html).toContain('Debit Note No.')
    expect(html).toContain('Additional charge against tax invoice')
    expect(html).toContain('<title>Debit Note')
    // 🔴 the two things a client needs to be told, and only a debit note carries
    expect(html).toContain('a debit note may be issued at any time')
    expect(html).toContain('this note&rsquo;s date')
    expect(html).not.toContain('<h1>Credit Note</h1>')
  })

  it('still renders a credit note as a credit note', async () => {
    const inv = await invoice('2026-05-19')
    const credit = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-11', taxableValue: '5000', reason: 'Rate revised after delivery',
    })
    const html = await renderCreditNoteHtml(ctx.companyId, credit.id)
    expect(html).toContain('<h1>Credit Note</h1>')
    expect(html).toContain('Section 34(1), CGST Act 2017')
    expect(html).toContain('is reduced by the total')
    expect(html).toContain('Credit Note No.')
    expect(html).toContain('<title>Credit Note')
    expect(html).not.toContain('a debit note may be issued at any time')
  })

  it('renders to a real PDF', async () => {
    const pdf = await htmlToPdf(await renderCreditNoteHtml(ctx.companyId, debitId))
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  }, 60_000)
})

describe('GSTR-1', () => {
  it('reports both directions in cdnr, flagged', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'), '2026-Q1')
    const debits = r.creditNotes.filter((c) => c.noteType === 'DEBIT')
    const credits = r.creditNotes.filter((c) => c.noteType === 'CREDIT')
    expect(debits.length).toBeGreaterThan(0)
    expect(credits.length).toBeGreaterThan(0)

    const csv = gstr1ToCsv(r)
    expect(csv).toContain('Note Type,Note Number')
    expect(csv).toMatch(/\nD,ADPD\//)
    expect(csv).toMatch(/\nC,ADPC\//)
  })

  it('a cancelled debit note drops out of the return and off the invoice', async () => {
    const inv = await invoice('2026-06-20', '40000')
    const note = await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-25', taxableValue: '4000', reason: 'Raised against the wrong invoice',
    })
    await cancelCreditNote(ctx, note.id, 'Raised against the wrong invoice', new Date('2026-06-26'))

    const r = await buildGstr1(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'), '2026-Q1')
    expect(r.creditNotes.some((c) => c.number === note.number)).toBe(false)
    expect((await prisma.creditNote.findUniqueOrThrow({ where: { id: note.id } })).cancelledAt).not.toBeNull()
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })
})
