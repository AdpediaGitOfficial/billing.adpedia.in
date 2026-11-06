import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, halveTax } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { assertFilesGstr1And3b } from './gst-registration'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { periodFor } from './periods'
import type { TaxMode } from '@prisma/client'

/**
 * Amending an invoice already reported — s.37(3), GSTR-1 table 9A. docs/52.
 *
 * 🔴 A filed invoice is never edited. Everything in this system already refuses to touch one:
 * the period is locked by the filing (docs/44), the bill-to details are frozen (docs/41), and
 * the credit note and set-off reversals refuse outright (docs/51). Every one of those
 * refusals ends by pointing at an amendment, and until now the system had no idea what one
 * was.
 *
 * What it is: the REVISED particulars, reported in a later return against the original
 * number and date. The original stays exactly as filed — the client holds a copy of it and
 * the portal has it — and the amendment carries what it should have said.
 */

/**
 * 🔴 The same deadline as a credit note, and for the same reason.
 *
 * s.37(3): no amendment after 30 November following the end of the financial year of supply,
 * or the date the annual return is filed, whichever is earlier. After that the figures as
 * filed are the figures, and a difference is settled commercially rather than reported.
 */
export function amendmentDeadline(invoiceDate: Date): Date {
  const month = invoiceDate.getUTCMonth() + 1
  const fyStartYear = month >= 4 ? invoiceDate.getUTCFullYear() : invoiceDate.getUTCFullYear() - 1
  return new Date(Date.UTC(fyStartYear + 1, 10, 30, 23, 59, 59))
}

export interface AmendmentInput {
  invoiceId: string
  /** the date the amendment is reported — it decides which return carries it */
  date: string
  reason: string
  /** the recipient's GSTIN as it should have been */
  gstin?: string
  /** the state code of the place of supply as it should have been */
  stateCode?: string
  /** the taxable value as it should have been. Omit to keep what was filed. */
  taxableValue?: string
}

export interface AmendmentPreview {
  invoiceNumber: string
  invoiceDate: Date
  originalPeriod: string
  amendmentPeriod: string
  deadline: Date
  withinDeadline: boolean
  filedAlready: boolean

  original: { gstin: string | null; placeOfSupply: string; taxMode: TaxMode; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; grandTotal: Decimal }
  revised: { gstin: string | null; placeOfSupply: string; taxMode: TaxMode; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; grandTotal: Decimal }
  /** revised less original, per account — what the amendment posts */
  delta: { revenue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; receivable: Decimal }
  changed: string[]
  warnings: string[]
}

/**
 * 🔴 The tax mode is DERIVED from the place of supply, never chosen.
 *
 * This is the whole reason an amendment can move money between tax accounts without the
 * invoice value changing by a rupee. An invoice to a Karnataka customer filed as intra-state
 * carries CGST and SGST that Kerala has been paid; the correction moves the same amount to
 * IGST, and the two states settle between themselves. The recipient cannot claim the credit
 * until it is reported under the right head, so this is a correction they chase us for.
 */
function modeFor(supplierStateCode: string | null, recipientStateCode: string | null, original: TaxMode): TaxMode {
  if (original === 'EXPORT' || original === 'SEZ_WITH_PAY' || original === 'SEZ_WITHOUT_PAY') return original
  if (!recipientStateCode || !supplierStateCode) return original
  return recipientStateCode === supplierStateCode ? 'INTRA' : 'INTER'
}

export async function previewAmendment(ctx: RequestContext, input: AmendmentInput): Promise<AmendmentPreview> {
  assertCan(ctx.role, 'invoices', 'read')

  const [inv, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { id: input.invoiceId, companyId: ctx.companyId },
      include: { customer: true, gstAmendments: { orderBy: { date: 'desc' } } },
    }),
    prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId }, select: { stateCode: true, gstFilingFrequency: true },
    }),
  ])
  if (!inv) throw new NotFound('Invoice not found')
  if (inv.status === 'DRAFT') throw new AppError('A draft has not been reported — edit it instead')
  if (inv.status === 'CANCELLED') throw new AppError('That invoice is cancelled — there is nothing to amend')

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')

  const originalPeriod = periodFor(inv.date, company.gstFilingFrequency)
  const amendmentPeriod = periodFor(date, company.gstFilingFrequency)

  // the latest state of the invoice as reported — an earlier amendment supersedes the original
  //
  // 🔴 The place of supply is a STATE CODE, as `Invoice.placeOfSupply` stores it and as GSTR-1
  // reports it. Holding a label here instead ("Kerala (32)") made every preview believe the
  // place of supply had changed, so an amendment with nothing in it looked like a real one.
  const last = inv.gstAmendments[0]
  const original = {
    gstin: last?.revisedGstin ?? inv.billToGstin ?? inv.customer.gstin,
    placeOfSupply: last?.revisedPlaceOfSupply ?? inv.placeOfSupply,
    taxMode: (last?.revisedTaxMode ?? inv.taxMode) as TaxMode,
    taxableValue: new Decimal((last?.revisedTaxableValue ?? inv.taxableValue).toString()),
    cgst: new Decimal((last?.revisedCgst ?? inv.cgst).toString()),
    sgst: new Decimal((last?.revisedSgst ?? inv.sgst).toString()),
    igst: new Decimal((last?.revisedIgst ?? inv.igst).toString()),
    grandTotal: new Decimal((last?.revisedGrandTotal ?? inv.grandTotal).toString()),
  }

  // the state as last reported, so a second amendment starts from the corrected one
  const currentStateCode = last?.revisedPlaceOfSupply ?? inv.billToStateCode ?? inv.customer.stateCode
  const stateCode = input.stateCode ?? currentStateCode
  const taxMode = modeFor(company.stateCode, stateCode, original.taxMode)
  const taxableValue = input.taxableValue !== undefined && input.taxableValue !== ''
    ? round2(new Decimal(input.taxableValue))
    : original.taxableValue

  // the rate as it was charged, so an amendment never silently re-rates the supply
  const originalTax = original.cgst.plus(original.sgst).plus(original.igst)
  const ratePct = original.taxableValue.gt(0) ? originalTax.div(original.taxableValue).mul(100) : ZERO
  const tax = round2(taxableValue.mul(ratePct).div(100))

  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (taxMode === 'INTRA') ({ cgst, sgst } = halveTax(tax))
  else if (taxMode === 'INTER') igst = tax

  const revised = {
    gstin: input.gstin !== undefined && input.gstin !== '' ? input.gstin.trim().toUpperCase() : original.gstin,
    placeOfSupply: taxMode === 'EXPORT' ? '96' : (stateCode ?? original.placeOfSupply),
    taxMode, taxableValue, cgst, sgst, igst,
    grandTotal: taxableValue.plus(cgst).plus(sgst).plus(igst),
  }

  const changed: string[] = []
  if (revised.gstin !== original.gstin) changed.push(`GSTIN ${original.gstin ?? '—'} → ${revised.gstin ?? '—'}`)
  if (revised.placeOfSupply !== original.placeOfSupply) changed.push(`place of supply ${original.placeOfSupply} → ${revised.placeOfSupply}`)
  if (revised.taxMode !== original.taxMode) changed.push(`${original.taxMode} → ${revised.taxMode}`)
  if (!revised.taxableValue.equals(original.taxableValue)) {
    changed.push(`taxable value ${original.taxableValue.toFixed(2)} → ${revised.taxableValue.toFixed(2)}`)
  }

  const warnings: string[] = []
  const deadline = amendmentDeadline(inv.date)
  const withinDeadline = date <= deadline
  if (!withinDeadline) {
    warnings.push(
      `The deadline for amending ${inv.number} passed on ${deadline.toISOString().slice(0, 10)} (s.37(3)). ` +
      'The figures as filed are now the figures — a difference after this is settled between the parties, not reported.',
    )
  }
  if (amendmentPeriod.label === originalPeriod.label) {
    warnings.push(
      `${amendmentPeriod.label} is the period the invoice itself sits in. An amendment belongs in a LATER return — ` +
      'if that return has not gone in yet, correct the invoice rather than amending it.',
    )
  }
  if (revised.taxMode !== original.taxMode) {
    warnings.push(
      `This moves the tax between heads: ${original.taxMode === 'INTRA' ? 'CGST and SGST' : 'IGST'} out, ` +
      `${revised.taxMode === 'INTRA' ? 'CGST and SGST' : 'IGST'} in. The recipient cannot claim the credit until it is ` +
      'reported under the right head, and the two states settle between themselves.',
    )
  }
  if (changed.length === 0) {
    warnings.push('Nothing is different from what was already reported.')
  }

  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel: originalPeriod.label, returnType: 'GSTR1', status: 'FILED' },
  })

  return {
    invoiceNumber: inv.number, invoiceDate: inv.date,
    originalPeriod: originalPeriod.label, amendmentPeriod: amendmentPeriod.label,
    deadline, withinDeadline, filedAlready: !!filed,
    original, revised,
    delta: {
      revenue: revised.taxableValue.minus(original.taxableValue),
      cgst: revised.cgst.minus(original.cgst),
      sgst: revised.sgst.minus(original.sgst),
      igst: revised.igst.minus(original.igst),
      receivable: revised.grandTotal.minus(original.grandTotal),
    },
    changed, warnings,
  }
}

/**
 * Record the amendment and post the difference.
 *
 * 🔴 Only the DIFFERENCE is posted, dated in the amendment period. The period the invoice
 * sits in is locked by the return that reported it, and re-posting the whole invoice there
 * would be both refused and wrong — the original figures were correct as far as the books of
 * that month are concerned; what changed is what they should have been.
 */
export async function recordAmendment(ctx: RequestContext, input: AmendmentInput) {
  assertCan(ctx.role, 'invoices.cancel', 'approve')
  // 🔴 docs/88 — a table 9A amendment corrects what was REPORTED in GSTR-1. An entity that files
  // no GSTR-1 has nothing to correct, and the screen no longer offers it; the server refuses
  // what the UI hides, so a typed URL cannot record one.
  await assertFilesGstr1And3b(ctx.companyId, 'GSTR-1 amendment')
  if (input.reason.trim().length < 5) {
    throw new AppError('An amendment needs a reason — it is reported in GSTR-1 and read by the client')
  }

  const date = new Date(input.date)

  // 🔴 The preview runs FIRST. `assertPostable` refuses a date outside any financial year, so
  // asking it before the deadline check answers "no financial year covers 2027-12-05" to
  // somebody whose actual problem is that s.37(3) ran out five days earlier — true, and
  // useless.
  const p = await previewAmendment(ctx, input)

  if (p.changed.length === 0) {
    throw new AppError('Nothing is different from what was already reported')
  }
  if (!p.withinDeadline) {
    throw new AppError(
      `The deadline for amending ${p.invoiceNumber} passed on ${p.deadline.toISOString().slice(0, 10)} (s.37(3)). ` +
      'The figures as filed are now the figures — a difference after this is settled between the parties, not reported.',
    )
  }

  const fy = await assertPostable(ctx.companyId, date)
  if (p.amendmentPeriod === p.originalPeriod) {
    throw new AppError(
      `An amendment belongs in a later return than the invoice it corrects. ${p.invoiceNumber} is in ` +
      `${p.originalPeriod}, and so is ${p.amendmentPeriod}.`,
    )
  }

  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: input.invoiceId, companyId: ctx.companyId } })

    const row = await tx.gstAmendment.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, invoiceId: inv.id,
        originalPeriod: p.originalPeriod, periodLabel: p.amendmentPeriod,
        date, reason: input.reason.trim(),
        revisedGstin: p.revised.gstin, revisedPlaceOfSupply: p.revised.placeOfSupply,
        revisedTaxMode: p.revised.taxMode,
        revisedTaxableValue: p.revised.taxableValue.toFixed(2),
        revisedCgst: p.revised.cgst.toFixed(2),
        revisedSgst: p.revised.sgst.toFixed(2),
        revisedIgst: p.revised.igst.toFixed(2),
        revisedGrandTotal: p.revised.grandTotal.toFixed(2),
        originalTaxableValue: p.original.taxableValue.toFixed(2),
        originalCgst: p.original.cgst.toFixed(2),
        originalSgst: p.original.sgst.toFixed(2),
        originalIgst: p.original.igst.toFixed(2),
      },
    })

    const d = p.delta
    // 🔴 one dimension object for every line. Spelled out per posting, four lines carried the
    // project and six did not, and the six were the tax — so an amended invoice moved its
    // project's output GST without the project ever hearing about it.
    const dim = { customerId: inv.customerId, projectId: inv.projectId ?? undefined }
    const postings = [
      ...(d.receivable.gt(0) ? [{ accountCode: '1100', debit: d.receivable, ...dim }] : []),
      ...(d.receivable.lt(0) ? [{ accountCode: '1100', credit: d.receivable.abs(), ...dim }] : []),
      ...(d.revenue.gt(0) ? [{ accountCode: '4010', credit: d.revenue, ...dim }] : []),
      ...(d.revenue.lt(0) ? [{ accountCode: '4010', debit: d.revenue.abs(), ...dim }] : []),
      ...(d.cgst.gt(0) ? [{ accountCode: '2110', credit: d.cgst, ...dim }] : []),
      ...(d.cgst.lt(0) ? [{ accountCode: '2110', debit: d.cgst.abs(), ...dim }] : []),
      ...(d.sgst.gt(0) ? [{ accountCode: '2120', credit: d.sgst, ...dim }] : []),
      ...(d.sgst.lt(0) ? [{ accountCode: '2120', debit: d.sgst.abs(), ...dim }] : []),
      ...(d.igst.gt(0) ? [{ accountCode: '2130', credit: d.igst, ...dim }] : []),
      ...(d.igst.lt(0) ? [{ accountCode: '2130', debit: d.igst.abs(), ...dim }] : []),
    ]

    // a particulars-only correction — a wrong GSTIN, say — moves no money at all, and a
    // journal with no postings is refused by assertBalanced. There is simply nothing to post.
    if (postings.length > 0) {
      await postJournal(ctx, {
        date,
        narration: `Amendment to ${inv.number} (${p.originalPeriod}) — ${input.reason.trim()}`,
        sourceType: 'GST_AMENDMENT', sourceId: row.id,
        postings,
      }, tx)
    }

    await audit(ctx, {
      entity: 'GstAmendment', entityId: row.id, action: 'CREATE',
      before: {
        gstin: p.original.gstin, placeOfSupply: p.original.placeOfSupply,
        taxableValue: p.original.taxableValue.toFixed(2),
      },
      after: {
        invoice: inv.number, period: p.amendmentPeriod, changed: p.changed,
        taxableValue: p.revised.taxableValue.toFixed(2),
      },
    }, tx)

    return row
  })
}

export async function listAmendments(ctx: RequestContext) {
  assertCan(ctx.role, 'invoices', 'read')
  return prisma.gstAmendment.findMany({
    where: { companyId: ctx.companyId },
    include: { invoice: { select: { number: true, date: true, customer: { select: { name: true } } } } },
    orderBy: { date: 'desc' },
  })
}

/** Amendments reported in a period — GSTR-1 table 9A. */
export async function amendmentsForPeriod(companyId: string, from: Date, to: Date) {
  return prisma.gstAmendment.findMany({
    where: { companyId, date: { gte: from, lte: to } },
    include: { invoice: { select: { number: true, date: true, customer: { select: { name: true } } } } },
    orderBy: { date: 'asc' },
  })
}

/** Where an invoice stands after every amendment — used by the invoice screen. */
export async function amendedState(companyId: string, invoiceId: string) {
  const rows = await prisma.gstAmendment.findMany({
    where: { companyId, invoiceId }, orderBy: { date: 'desc' }, take: 1,
  })
  return rows[0] ?? null
}
