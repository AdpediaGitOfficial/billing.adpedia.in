import { prisma } from '@/server/db'
import { archiveIssuedDocument } from '@/server/services/storage/document-archive'
import { renderCreditNoteHtml } from './render-credit-note'
import { Decimal, ZERO, round2, halveTax } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { allocateNumber } from './numbering'

/**
 * Debit notes — s.34(3) of the CGST Act. docs/53.
 *
 * The mirror of the credit note: where the value or the tax charged on an invoice turns out
 * to be **less** than it should have been, the supplier issues a debit note and the client
 * owes more. Same document under rule 53(1A), same `cdnr` table in GSTR-1, opposite sign.
 *
 * 🔴 And NOT the same rules, in three ways that are easy to get wrong by copying the credit
 * note — which is exactly what this module had to resist:
 *
 *   1. **There is no deadline.** s.34(2) time-bars a credit note to 30 November following the
 *      financial year, because a credit note reduces the government's tax. A debit note
 *      increases it, so nothing restricts when it may be issued.
 *   2. **The tax belongs to the month the note is issued**, not to the invoice's month —
 *      s.34(4). So there is no interest for the period in between, which is the first thing
 *      people assume there must be.
 *   3. **The recipient's credit runs from the note's own date.** s.16(4) was amended with
 *      effect from 01 Jan 2021 to key the deadline to the debit note rather than to the
 *      original invoice, so a debit note raised a year later still gives the client credit.
 *      Guidance written before 2021 says the opposite.
 */

export interface DebitNoteInput {
  invoiceId: string
  date: string
  reason: string
  /** the additional taxable value being charged */
  taxableValue: string
}

export interface DebitNotePreview {
  invoiceNumber: string
  invoiceDate: Date
  taxMode: string
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  grandTotal: Decimal
  /** what the invoice will owe once this is issued */
  invoiceTotalAfter: Decimal
  notes: string[]
  warnings: string[]
}

async function loadInvoice(ctx: RequestContext, invoiceId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    include: { customer: true, financialYear: true, creditNotes: { where: { cancelledAt: null } } },
  })
  if (!inv) throw new NotFound('Invoice not found')
  if (inv.status === 'DRAFT') throw new AppError('That invoice has not been issued — edit it instead')
  if (inv.status === 'CANCELLED') throw new AppError('That invoice is cancelled — a debit note cannot attach to it')
  return inv
}

/** The effective GST rate on the invoice as issued, so the extra carries the same tax. */
function rateOf(inv: { taxableValue: unknown; cgst: unknown; sgst: unknown; igst: unknown }) {
  const taxable = new Decimal(String(inv.taxableValue))
  if (taxable.lte(0)) return ZERO
  const tax = new Decimal(String(inv.cgst)).plus(String(inv.sgst)).plus(String(inv.igst))
  return tax.div(taxable).mul(100)
}

export async function previewDebitNote(
  ctx: RequestContext, input: { invoiceId: string; date: string; taxableValue: string },
): Promise<DebitNotePreview> {
  assertCan(ctx.role, 'invoices', 'read')

  const inv = await loadInvoice(ctx, input.invoiceId)
  const taxable = round2(new Decimal(input.taxableValue || '0'))

  const ratePct = rateOf(inv)
  const tax = round2(taxable.mul(ratePct).div(100))

  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (inv.taxMode === 'INTRA') ({ cgst, sgst } = halveTax(tax))
  else if (inv.taxMode === 'INTER') igst = tax
  // an export stays zero-rated: there was no tax to charge, and there is none to add

  const grandTotal = taxable.plus(cgst).plus(sgst).plus(igst)

  const notes: string[] = [
    'The tax on a debit note belongs to the month it is issued (s.34(4)) — not to the month of the ' +
    'invoice it relates to. No interest runs for the period in between.',
    'The recipient may claim the credit by the s.16(4) deadline measured from THIS note’s date, not ' +
    'from the original invoice — s.16(4) was amended to that effect with effect from 01 January 2021.',
  ]
  if (inv.taxMode === 'EXPORT') {
    notes.push('The invoice is a zero-rated export, so the additional value carries no GST either.')
  }

  const warnings: string[] = []
  if (taxable.lte(0)) warnings.push('A debit note needs a positive value')
  const credited = inv.creditNotes
    .filter((c) => c.noteType === 'CREDIT')
    .reduce((a, c) => a.plus(c.grandTotal.toString()), ZERO)
  if (credited.gt(0)) {
    warnings.push(
      `${credited.toFixed(2)} has already been credited against ${inv.number}. Raising a debit note now ` +
      'charges it back — if the credit note itself was wrong, reversing that is the cleaner correction.',
    )
  }
  if (new Decimal(inv.tdsCredited.toString()).gt(0)) {
    warnings.push(
      'The client has already withheld TDS on this invoice. They will deduct again on the additional ' +
      'value when they pay it, which is correct — the deduction follows the payment, not the invoice.',
    )
  }

  const debited = inv.creditNotes
    .filter((c) => c.noteType === 'DEBIT')
    .reduce((a, c) => a.plus(c.grandTotal.toString()), ZERO)

  return {
    invoiceNumber: inv.number, invoiceDate: inv.date, taxMode: inv.taxMode,
    taxableValue: taxable, cgst, sgst, igst, grandTotal,
    invoiceTotalAfter: new Decimal(inv.grandTotal.toString()).minus(credited).plus(debited).plus(grandTotal),
    notes, warnings,
  }
}

/**
 * Issue the debit note.
 *
 * 🔴 The invoice posting again, for the additional value only: receivable up, revenue up,
 * output tax up. It is not an amendment — the invoice was right for what it covered, and this
 * charges something further.
 */
export async function createDebitNote(ctx: RequestContext, input: DebitNoteInput) {
  assertCan(ctx.role, 'invoices', 'write')
  if (input.reason.trim().length < 5) {
    throw new AppError('A debit note needs a reason — it is reported in GSTR-1 and read by the client')
  }

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')
  const fy = await assertPostable(ctx.companyId, date)

  const p = await previewDebitNote(ctx, input)
  if (p.taxableValue.lte(0)) throw new AppError('A debit note needs a positive value')

  const note = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: input.invoiceId, companyId: ctx.companyId } })

    const { number } = await allocateNumber(tx, {
      companyId: ctx.companyId, financialYearId: fy.id, docType: 'DEBIT_NOTE', fyLabel: fy.label,
    })

    const note = await tx.creditNote.create({
      data: {
        noteType: 'DEBIT',
        companyId: ctx.companyId, financialYearId: fy.id, invoiceId: inv.id,
        number, date, reason: input.reason.trim(),
        taxableValue: p.taxableValue.toFixed(2),
        cgst: p.cgst.toFixed(2), sgst: p.sgst.toFixed(2), igst: p.igst.toFixed(2),
        grandTotal: p.grandTotal.toFixed(2),
        // 🔴 Always true for a debit note. s.34(2) restricts credit notes only, so there is
        // no state in which a debit note's tax is "not adjusted" — the liability is simply
        // declared in the month it is issued.
        gstAdjusted: true,
      },
    })

    await postJournal(ctx, {
      date, narration: `Debit note ${number} against ${inv.number} — ${input.reason.trim()}`,
      sourceType: 'CREDIT_NOTE', sourceId: note.id,
      postings: [
        { accountCode: '1100', debit: p.grandTotal, customerId: inv.customerId, projectId: inv.projectId ?? undefined },
        { accountCode: '4010', credit: p.taxableValue, customerId: inv.customerId, projectId: inv.projectId ?? undefined },
        ...(p.cgst.gt(0) ? [{ accountCode: '2110', credit: p.cgst, customerId: inv.customerId }] : []),
        ...(p.sgst.gt(0) ? [{ accountCode: '2120', credit: p.sgst, customerId: inv.customerId }] : []),
        ...(p.igst.gt(0) ? [{ accountCode: '2130', credit: p.igst, customerId: inv.customerId }] : []),
      ],
    }, tx)

    // 🔴 More is owed, so an invoice that was settled is not settled any more.
    const settled = new Decimal(inv.amountReceived.toString()).plus(inv.tdsCredited.toString())
    if (inv.status === 'PAID' && settled.lt(p.invoiceTotalAfter.minus('0.5'))) {
      await tx.invoice.update({
        where: { id: inv.id },
        data: { status: settled.gt(0) ? 'PARTIALLY_PAID' : 'SENT' },
      })
    }

    await audit(ctx, {
      entity: 'CreditNote', entityId: note.id, action: 'CREATE',
      after: { noteType: 'DEBIT', number, against: inv.number, grandTotal: p.grandTotal.toFixed(2) },
    }, tx)

    return note
  })

  // 🔴 docs/59 — a note is issued the moment it is raised, so the document is archived here,
  // after the transaction and without power to fail it.
  await archiveIssuedDocument(ctx, {
    kind: 'CREDIT_NOTE', entityType: 'CreditNote', entityId: note.id,
    filename: `${note.number}.pdf`,
    render: () => renderCreditNoteHtml(ctx.companyId, note.id),
  })

  return note
}
