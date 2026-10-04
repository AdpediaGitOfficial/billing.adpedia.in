import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, halveTax, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { gstAdjustmentDeadline } from '@/server/services/invoicing/credit-note'
import { amendmentDeadline } from './gst-amendment'
import { periodFor } from './periods'

/**
 * Amending a credit or debit note already reported — s.37(3), GSTR-1 table 9C. docs/66.
 *
 * docs/52 built the same thing for an invoice (table 9A). This is its mirror, and the reason
 * it is a separate service rather than a flag on that one is that the rules which govern it
 * are different statutes — a model serving both would have every rule written as "unless it
 * is a note", which is how the rule that matters gets lost.
 */

export type NoteDirection = 'CREDIT' | 'DEBIT'

export interface NoteAmendmentInput {
  noteId: string
  /** the date the amendment is reported — it decides which return carries it */
  date: string
  reason: string
  /** the taxable value as it should have been. Omit to keep what was filed. */
  taxableValue?: string
}

export interface NoteAmendmentPreview {
  noteNumber: string
  noteDate: Date
  noteType: NoteDirection
  againstInvoice: string | null
  invoiceDate: Date | null
  gstAdjusted: boolean
  originalPeriod: string
  amendmentPeriod: string

  /** s.37(3) — when the amendment itself may still be reported */
  reportingDeadline: Date
  withinReportingDeadline: boolean
  /** s.34(2) — when a CREDIT note may still reduce output tax. Null for a debit note. */
  creditDeadline: Date | null
  withinCreditDeadline: boolean

  original: { taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; grandTotal: Decimal }
  revised: { taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; grandTotal: Decimal }
  delta: { revenue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; receivable: Decimal }
  /** true when the amendment increases the credit, which is what s.34(2) governs */
  increasesCredit: boolean
  changed: string[]
  warnings: string[]
  /** set when the amendment cannot be made at all, with the reason */
  refusal: string | null
}

export async function previewNoteAmendment(
  ctx: RequestContext, input: NoteAmendmentInput,
): Promise<NoteAmendmentPreview> {
  assertCan(ctx.role, 'invoices', 'read')

  const [note, company] = await Promise.all([
    prisma.creditNote.findFirst({
      where: { id: input.noteId, companyId: ctx.companyId },
      include: { invoice: { select: { number: true, date: true } }, amendments: { orderBy: { date: 'desc' } } },
    }),
    prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId }, select: { gstFilingFrequency: true },
    }),
  ])
  if (!note) throw new NotFound('Note not found')
  if (note.cancelledAt) throw new AppError(`${note.number} is cancelled — there is nothing to amend`)

  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('That is not a valid date')

  const isCredit = note.noteType === 'CREDIT'
  const originalPeriod = periodFor(note.date, company.gstFilingFrequency)
  const amendmentPeriod = periodFor(date, company.gstFilingFrequency)

  // an earlier amendment supersedes the note, exactly as it does for an invoice
  const last = note.amendments[0]
  const original = {
    taxableValue: new Decimal((last?.revisedTaxableValue ?? note.taxableValue).toString()),
    cgst: new Decimal((last?.revisedCgst ?? note.cgst).toString()),
    sgst: new Decimal((last?.revisedSgst ?? note.sgst).toString()),
    igst: new Decimal((last?.revisedIgst ?? note.igst).toString()),
    grandTotal: new Decimal((last?.revisedGrandTotal ?? note.grandTotal).toString()),
  }

  const taxableValue = input.taxableValue !== undefined && input.taxableValue !== ''
    ? round2(new Decimal(input.taxableValue))
    : original.taxableValue

  /**
   * 🔴 The rate is derived from what was reported, never from today's table.
   *
   * The same rule as docs/52 and docs/48: a note carries the rate the supply was charged at,
   * and an amendment corrects a figure — it must never silently re-rate the supply because a
   * notification moved in the meantime.
   */
  const originalTax = original.cgst.plus(original.sgst).plus(original.igst)
  const ratePct = original.taxableValue.gt(0) ? originalTax.div(original.taxableValue).mul(100) : ZERO
  const tax = round2(taxableValue.mul(ratePct).div(100))

  // the heads follow the note, which followed its invoice — a note cannot change tax mode
  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (original.igst.gt(0)) igst = tax
  else if (originalTax.gt(0)) ({ cgst, sgst } = halveTax(tax))

  const revised = {
    taxableValue, cgst, sgst, igst,
    grandTotal: taxableValue.plus(cgst).plus(sgst).plus(igst),
  }

  const delta = {
    revenue: revised.taxableValue.minus(original.taxableValue),
    cgst: revised.cgst.minus(original.cgst),
    sgst: revised.sgst.minus(original.sgst),
    igst: revised.igst.minus(original.igst),
    receivable: revised.grandTotal.minus(original.grandTotal),
  }

  const changed: string[] = []
  if (!revised.taxableValue.equals(original.taxableValue)) {
    changed.push(`taxable value ${original.taxableValue.toFixed(2)} → ${revised.taxableValue.toFixed(2)}`)
  }

  const warnings: string[] = []
  let refusal: string | null = null

  // ── s.37(3): when the amendment may be reported at all ──────────────────────
  const reportingDeadline = amendmentDeadline(note.date)
  const withinReportingDeadline = date <= reportingDeadline
  if (!withinReportingDeadline) {
    refusal =
      `The deadline for amending ${note.number} passed on ${reportingDeadline.toISOString().slice(0, 10)} ` +
      '(s.37(3)). The figures as filed are now the figures — a difference after this is settled between the ' +
      'parties, not reported.'
  }

  /**
   * ── 🔴 s.34(2): the deadline a DEBIT note does not have ───────────────────
   *
   * This is the asymmetry the whole module turns on, and it is invisible if 9C is treated as
   * 9A with a different table number.
   *
   * A credit note reduces output tax, and s.34(2) allows that only until 30 November
   * following the financial year **of the original supply** — not of the note. Amending a
   * credit note *upward* after that date claims a further reduction that s.34(2) has already
   * closed, whatever s.37(3) says about reporting windows. The two deadlines are different
   * statutes answering different questions, and the earlier one governs.
   *
   * A debit note increases tax. s.34(3) imposes no time limit at all (docs/53), so there is
   * nothing to be late for — and increasing one is the department's gain, which is never the
   * thing a statute hurries to bar.
   */
  const creditDeadline = isCredit && note.invoice ? gstAdjustmentDeadline(note.invoice.date) : null
  const increasesCredit = isCredit && delta.receivable.gt(0)
  const withinCreditDeadline = creditDeadline === null || date <= creditDeadline

  /**
   * 🔴 s.37(3) first, and it is not overwritten.
   *
   * When both deadlines have passed the reader gets one message, and it has to be the one
   * that settles the question: if the amendment cannot be REPORTED at all, whether s.34(2)
   * would have allowed the relief is moot. The first version let the s.34(2) branch overwrite
   * it, so a note years out of time was refused for the wrong reason.
   */
  if (refusal === null && isCredit && increasesCredit && !withinCreditDeadline) {
    refusal =
      `This increases the credit on ${note.number} by ${formatINR(delta.receivable)}, and s.34(2) closed on ` +
      `${creditDeadline!.toISOString().slice(0, 10)} — 30 November following the financial year of invoice ` +
      `${note.invoice!.number}. The output tax already paid stays paid. Issue a commercial credit note for the ` +
      'difference instead: the client is credited and no GST is recovered.'
  }
  if (isCredit && !increasesCredit && !delta.receivable.isZero() && !withinCreditDeadline) {
    warnings.push(
      `s.34(2) closed on ${creditDeadline!.toISOString().slice(0, 10)}, but this REDUCES the credit — giving ` +
      'back tax that was over-recovered is always open, so the amendment stands.',
    )
  }

  // ── a commercial note adjusted no tax, and an amendment must not start ──────
  if (!note.gstAdjusted) {
    if (revised.cgst.plus(revised.sgst).plus(revised.igst).gt(0)) {
      refusal = refusal ??
        `${note.number} was issued past the s.34(2) deadline and carries no GST. An amendment cannot ` +
        'put tax on it — that would recover output tax the deadline has already closed.'
    } else {
      warnings.push(
        `${note.number} adjusts no GST, so this amendment changes the value reported and no tax. It is reported ` +
        'in table 9C all the same, because the value filed was wrong.',
      )
    }
  }

  if (amendmentPeriod.label === originalPeriod.label) {
    warnings.push(
      `${amendmentPeriod.label} is the period the note itself sits in. An amendment belongs in a LATER return — ` +
      'if that return has not gone in yet, correct the note rather than amending it.',
    )
  }
  if (changed.length === 0) warnings.push('Nothing is different from what was already reported.')
  if (!note.invoiceId) {
    warnings.push('This note is not tied to an invoice, so no s.34(2) deadline can be worked out for it. Check it with the CA.')
  }

  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel: originalPeriod.label, returnType: 'GSTR1', status: 'FILED' },
  })
  if (!filed) {
    warnings.push(
      `GSTR-1 for ${originalPeriod.label} is not recorded as filed. Nothing has been reported yet, so the note ` +
      'can still be cancelled and reissued, which is simpler than an amendment.',
    )
  }

  return {
    noteNumber: note.number, noteDate: note.date,
    noteType: note.noteType as NoteDirection,
    againstInvoice: note.invoice?.number ?? null,
    invoiceDate: note.invoice?.date ?? null,
    gstAdjusted: note.gstAdjusted,
    originalPeriod: originalPeriod.label, amendmentPeriod: amendmentPeriod.label,
    reportingDeadline, withinReportingDeadline,
    creditDeadline, withinCreditDeadline,
    original, revised, delta, increasesCredit, changed, warnings, refusal,
  }
}

/**
 * Record the amendment and post the difference.
 *
 * 🔴 Only the DIFFERENCE, dated in the amendment period — the same rule as docs/52. The
 * period the note sits in is locked by the return that reported it.
 *
 * The signs mirror the note itself: a credit note debits revenue and the output tax heads
 * and credits the receivable, so an amendment that increases the credit does more of the
 * same, and one that reduces it does the reverse.
 */
export async function recordNoteAmendment(ctx: RequestContext, input: NoteAmendmentInput) {
  assertCan(ctx.role, 'invoices.cancel', 'approve')
  if (input.reason.trim().length < 5) {
    throw new AppError('An amendment needs a reason — it is reported in GSTR-1 and read by the client')
  }

  // 🔴 the preview runs FIRST, so a refusal is answered in its own words rather than by
  // `assertPostable` complaining about a financial year — the docs/52 §ordering lesson
  const p = await previewNoteAmendment(ctx, input)
  if (p.refusal) throw new AppError(p.refusal)
  if (p.changed.length === 0) throw new AppError('Nothing is different from what was already reported')

  const date = new Date(input.date)
  const fy = await assertPostable(ctx.companyId, date)

  const note = await prisma.creditNote.findFirstOrThrow({
    where: { id: input.noteId, companyId: ctx.companyId },
    include: { invoice: { select: { customerId: true, projectId: true } } },
  })

  return prisma.$transaction(async (tx) => {
    const amendment = await tx.gstNoteAmendment.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, noteId: note.id,
        originalPeriod: p.originalPeriod, periodLabel: p.amendmentPeriod,
        date, reason: input.reason.trim(),
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

    const customerId = note.invoice?.customerId
    const postings = [
      ...(p.delta.revenue.isZero() ? [] : [{
        accountCode: '4010',
        ...(p.delta.revenue.gt(0) ? { debit: p.delta.revenue } : { credit: p.delta.revenue.abs() }),
        customerId, projectId: note.invoice?.projectId ?? undefined,
      }]),
      ...(p.delta.cgst.isZero() ? [] : [{
        accountCode: '2110',
        ...(p.delta.cgst.gt(0) ? { debit: p.delta.cgst } : { credit: p.delta.cgst.abs() }),
        customerId,
      }]),
      ...(p.delta.sgst.isZero() ? [] : [{
        accountCode: '2120',
        ...(p.delta.sgst.gt(0) ? { debit: p.delta.sgst } : { credit: p.delta.sgst.abs() }),
        customerId,
      }]),
      ...(p.delta.igst.isZero() ? [] : [{
        accountCode: '2130',
        ...(p.delta.igst.gt(0) ? { debit: p.delta.igst } : { credit: p.delta.igst.abs() }),
        customerId,
      }]),
      ...(p.delta.receivable.isZero() ? [] : [{
        accountCode: '1100',
        ...(p.delta.receivable.gt(0) ? { credit: p.delta.receivable } : { debit: p.delta.receivable.abs() }),
        customerId,
      }]),
    ]

    if (postings.length > 0) {
      await postJournal(ctx, {
        date,
        narration: `Amendment to ${note.noteType === 'DEBIT' ? 'debit' : 'credit'} note ${note.number} — ${input.reason.trim()}`,
        sourceType: 'CREDIT_NOTE', sourceId: note.id,
        postings,
      }, tx)
    }

    await audit(ctx, {
      entity: 'GstNoteAmendment', entityId: amendment.id, action: 'CREATE',
      after: {
        note: note.number, originalPeriod: p.originalPeriod, reportedIn: p.amendmentPeriod,
        delta: p.delta.receivable.toFixed(2), reason: input.reason.trim(),
      },
    }, tx)

    return amendment
  })
}

export async function listNoteAmendments(ctx: RequestContext) {
  assertCan(ctx.role, 'invoices', 'read')
  return prisma.gstNoteAmendment.findMany({
    where: { companyId: ctx.companyId },
    include: { note: { select: { number: true, date: true, noteType: true, invoice: { select: { number: true } } } } },
    orderBy: { date: 'desc' },
  })
}

/** Table 9C for a period. */
export async function noteAmendmentsForPeriod(companyId: string, from: Date, to: Date) {
  return prisma.gstNoteAmendment.findMany({
    where: { companyId, date: { gte: from, lte: to } },
    include: {
      note: {
        select: {
          number: true, date: true, noteType: true,
          invoice: { select: { number: true, date: true, billToGstin: true, placeOfSupply: true } },
        },
      },
    },
    orderBy: { date: 'asc' },
  })
}
