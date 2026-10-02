import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { allocateNumber } from './numbering'
import { halveTax } from '@/lib/money'

/**
 * Credit notes — s.34(1) of the CGST Act.
 *
 * 🔴 This closes a dead end the software itself pointed at. `cancelInvoice` refuses once a
 * receipt exists and says "raise a credit note instead", and GSTR-1 already builds a `cdnr`
 * table from a `CreditNote` row nothing could create. The return's credit-note section has
 * been permanently empty.
 *
 * A credit note is NOT a cancellation. The invoice stays issued and reported; the credit note
 * is its own document, separately numbered and separately reported, which reduces what is
 * owed. That distinction is the whole reason it exists: a tax invoice that has been acted on
 * cannot be unsaid.
 */

/**
 * 🔴 The deadline in s.34(2).
 *
 * A credit note may only reduce OUTPUT TAX LIABILITY if it is issued by **30 November
 * following the end of the financial year** in which the supply was made (or the date the
 * annual return is filed, whichever is earlier).
 *
 * After that a commercial credit note is still perfectly valid between the parties — you can
 * agree to charge less — but the GST already paid cannot be recovered. Getting this wrong is
 * expensive and silent: the note looks the same either way, and the shortfall only appears
 * when the return is reconciled.
 */
export function gstAdjustmentDeadline(invoiceDate: Date): Date {
  // Indian FY: a supply on 15 May 2026 is in FY 2026-27, which ends 31 Mar 2027,
  // so the deadline is 30 Nov 2027.
  const month = invoiceDate.getUTCMonth() + 1
  const fyStartYear = month >= 4 ? invoiceDate.getUTCFullYear() : invoiceDate.getUTCFullYear() - 1
  return new Date(Date.UTC(fyStartYear + 1, 10, 30, 23, 59, 59))   // 30 November
}

export function canAdjustGst(invoiceDate: Date, creditNoteDate: Date): boolean {
  return creditNoteDate <= gstAdjustmentDeadline(invoiceDate)
}

export interface CreditNoteInput {
  invoiceId: string
  date: string
  reason: string
  /** the taxable value being credited — tax is derived from the invoice's own rate.
   *  Ignored, and may be omitted, when `full` is set. */
  taxableValue?: string
  /** true to credit the whole remaining invoice */
  full?: boolean
}

export interface CreditNotePreview {
  invoiceNumber: string
  invoiceDate: Date
  taxMode: string
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  grandTotal: Decimal
  /** the most that may still be credited against this invoice */
  creditable: Decimal
  gstAdjustable: boolean
  /** 🔴 tax that cannot be recovered because the s.34(2) deadline has passed */
  taxNotAdjusted: Decimal
  deadline: Date
  nextNumber: string | null
  warnings: string[]
}

async function loadInvoice(ctx: RequestContext, invoiceId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    include: { customer: true, financialYear: true, creditNotes: true },
  })
  if (!inv) throw new NotFound('Invoice not found')
  if (inv.status === 'DRAFT') throw new AppError('That invoice has not been issued — edit or cancel it instead')
  if (inv.status === 'CANCELLED') throw new AppError('That invoice is cancelled — there is nothing to credit')
  return inv
}

/** The effective GST rate on the invoice as issued, so a credit carries the same tax. */
function rateOf(inv: { taxableValue: unknown; cgst: unknown; sgst: unknown; igst: unknown }) {
  const taxable = new Decimal(String(inv.taxableValue))
  if (taxable.lte(0)) return ZERO
  const tax = new Decimal(String(inv.cgst)).plus(String(inv.sgst)).plus(String(inv.igst))
  return tax.div(taxable).mul(100)
}

export async function previewCreditNote(
  ctx: RequestContext, input: { invoiceId: string; date: string; taxableValue?: string; full?: boolean },
): Promise<CreditNotePreview> {
  assertCan(ctx.role, 'invoices', 'read')

  const inv = await loadInvoice(ctx, input.invoiceId)
  const date = new Date(input.date)

  const alreadyCredited = inv.creditNotes.reduce((a, c) => a.plus(c.taxableValue.toString()), ZERO)
  const creditable = new Decimal(inv.taxableValue.toString()).minus(alreadyCredited)

  const taxable = input.full
    ? creditable
    : round2(new Decimal(input.taxableValue ?? '0'))

  const ratePct = rateOf(inv)
  const tax = round2(taxable.mul(ratePct).div(100))

  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (inv.taxMode === 'INTRA') ({ cgst, sgst } = halveTax(tax))
  else if (inv.taxMode === 'INTER') igst = tax
  // EXPORT stays zero-rated — there was no tax to credit

  const warnings: string[] = []
  const gstAdjustable = canAdjustGst(inv.date, date)

  // 🔴 Past the deadline the note carries NO TAX — docs/48.
  //
  // This screen already said the GST could not be recovered, and the posting recovered it
  // anyway: output GST was debited and the note went into GSTR-1's cdnr table. The books
  // then claimed a reduction the return cannot support, and the portal would reject the
  // table that carried it. The client is still credited the full gross; what changes is that
  // the tax inside it is a cost the company bears, not tax it gets back.
  const taxNotAdjusted = gstAdjustable ? ZERO : tax
  if (!gstAdjustable) {
    cgst = ZERO; sgst = ZERO; igst = ZERO
    warnings.push(
      `The deadline for adjusting GST on ${inv.number} passed on ${gstAdjustmentDeadline(inv.date).toISOString().slice(0, 10)} (s.34(2)). ` +
      `This is a commercial credit note: the client is credited the full ${taxable.plus(tax).toFixed(2)}, ` +
      `but the ${tax.toFixed(2)} of GST already paid stays paid, is not reported in GSTR-1, and lands in the P&L.`,
    )
  }
  if (taxable.gt(creditable)) {
    warnings.push(`Only ${creditable.toFixed(2)} of ${inv.number} is left to credit`)
  }
  if (new Decimal(inv.tdsCredited.toString()).gt(0)) {
    warnings.push(
      'The client has already withheld TDS on this invoice. A credit note does not undo that — ' +
      'the excess shows up in their 26AS reconciliation and is settled against the next deduction.',
    )
  }

  return {
    invoiceNumber: inv.number, invoiceDate: inv.date, taxMode: inv.taxMode,
    taxableValue: taxable, cgst, sgst, igst,
    // the client is credited the same gross either way — only its composition changes
    grandTotal: taxable.plus(cgst).plus(sgst).plus(igst).plus(taxNotAdjusted),
    creditable, gstAdjustable, taxNotAdjusted, deadline: gstAdjustmentDeadline(inv.date),
    nextNumber: null, warnings,
  }
}

/**
 * Issue the credit note.
 *
 * The journal is the invoice posting in reverse, for the credited portion only: output GST is
 * debited back, revenue is debited, and accounts receivable is credited — which is what
 * actually reduces what the client owes.
 */
export async function createCreditNote(ctx: RequestContext, input: CreditNoteInput) {
  assertCan(ctx.role, 'invoices.cancel', 'approve')
  if (input.reason.trim().length < 5) {
    throw new AppError('A credit note needs a reason — it is reported in GSTR-1 and read by the client')
  }

  const date = new Date(input.date)
  const fy = await assertPostable(ctx.companyId, date)
  const preview = await previewCreditNote(ctx, input)

  if (preview.taxableValue.lte(0)) throw new AppError('A credit note needs a positive value')
  if (preview.taxableValue.gt(preview.creditable.plus('0.5'))) {
    throw new AppError(
      `Crediting ${preview.taxableValue.toFixed(2)} exceeds the ${preview.creditable.toFixed(2)} still open on ${preview.invoiceNumber}`,
    )
  }

  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: input.invoiceId, companyId: ctx.companyId } })

    const { number } = await allocateNumber(tx, {
      companyId: ctx.companyId, financialYearId: fy.id, docType: 'CREDIT_NOTE', fyLabel: fy.label,
    })

    const note = await tx.creditNote.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, invoiceId: inv.id,
        number, date, reason: input.reason.trim(),
        taxableValue: preview.taxableValue.toFixed(2),
        cgst: preview.cgst.toFixed(2), sgst: preview.sgst.toFixed(2), igst: preview.igst.toFixed(2),
        grandTotal: preview.grandTotal.toFixed(2),
        gstAdjusted: preview.gstAdjustable,
        taxNotAdjusted: preview.taxNotAdjusted.toFixed(2),
      },
    })

    // 🔴 The invoice posting in reverse, for the credited portion only. Crediting AR is what
    // reduces what the client owes; debiting output GST is what reduces the liability — and
    // the latter is exactly what s.34(2) governs.
    await postJournal(ctx, {
      date, narration: `Credit note ${number} against ${inv.number} — ${input.reason.trim()}`,
      sourceType: 'CREDIT_NOTE', sourceId: note.id,
      postings: [
        { accountCode: '1100', credit: preview.grandTotal, customerId: inv.customerId, projectId: inv.projectId ?? undefined },
        // 🔴 Where the GST cannot be recovered it is NOT debited back to the tax accounts —
        // that would reduce a liability the return still has to carry. The whole gross comes
        // off revenue instead, which is what the company actually gave back.
        {
          accountCode: '4010',
          debit: preview.taxableValue.plus(preview.taxNotAdjusted),
          customerId: inv.customerId, projectId: inv.projectId ?? undefined,
          narration: preview.taxNotAdjusted.gt(0)
            ? `includes ${preview.taxNotAdjusted.toFixed(2)} of GST that cannot be recovered — s.34(2) deadline passed`
            : undefined,
        },
        ...(preview.cgst.gt(0) ? [{ accountCode: '2110', debit: preview.cgst, customerId: inv.customerId }] : []),
        ...(preview.sgst.gt(0) ? [{ accountCode: '2120', debit: preview.sgst, customerId: inv.customerId }] : []),
        ...(preview.igst.gt(0) ? [{ accountCode: '2130', debit: preview.igst, customerId: inv.customerId }] : []),
      ],
    }, tx)

    // the invoice is now settled to the extent it has been credited
    const settled = new Decimal(inv.amountReceived.toString())
      .plus(inv.tdsCredited.toString())
      .plus(preview.grandTotal)
    const status = settled.gte(new Decimal(inv.grandTotal.toString()).minus('0.5')) ? 'PAID' : inv.status

    await tx.invoice.update({ where: { id: inv.id }, data: { status } })

    await audit(ctx, {
      entity: 'CreditNote', entityId: note.id, action: 'CREATE',
      after: {
        number, against: inv.number, grandTotal: preview.grandTotal.toFixed(2),
        gstAdjustable: preview.gstAdjustable, taxNotAdjusted: preview.taxNotAdjusted.toFixed(2),
      },
    }, tx)

    return note
  })
}

export async function listCreditNotes(ctx: RequestContext) {
  assertCan(ctx.role, 'invoices', 'read')
  return prisma.creditNote.findMany({
    where: { companyId: ctx.companyId },
    include: { invoice: { select: { id: true, number: true, customer: { select: { name: true } } } } },
    orderBy: { date: 'desc' },
  })
}
