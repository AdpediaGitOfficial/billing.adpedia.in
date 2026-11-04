import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'

import type { RequestContext } from '@/server/context'
import { AppError, NotFound } from '@/server/errors'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { resolveFy, assertPostable } from '@/server/services/accounting/period'
import { postJournal, reverseJournal } from '@/server/services/accounting/journal'
import { postInvoice, revenueFromLines } from '@/server/services/accounting/rules/invoice'
import { resolveTaxMode, placeOfSupplyLabel, requiresLut } from '@/server/services/tax/tax-mode'
import { computeInvoice, type LineInput } from '@/server/services/tax/gst'
import { computeInvoiceTds, defaultRateFor } from '@/server/services/tax/tds'
import { allocateNumber, peekNextNumber } from './numbering'
import { docTypeFor, carriesTax, assertMayChargeGst } from './document-type'
import { resolveLutForInvoice } from './lut'
import { validateSac, sacLooksWrongForDescription } from './sac'
import { archiveIssuedDocument } from '@/server/services/storage/document-archive'
import { pdfFilename } from './pdf'
import { renderInvoiceHtml } from './render'

/**
 * 🔴 ONE rule for the billing currency, used by both the preview and the create path.
 *
 * They had drifted: the preview inferred AED for a UAE customer while create always wrote
 * USD, so the figure shown on screen before saving disagreed with the invoice that was
 * actually issued. The currency is a commercial term agreed with the client — an Indian
 * exporter routinely bills a UAE client in USD — so it is read from the customer record
 * rather than guessed from their country.
 */
export interface LineSacIssue { line: number; description: string; level: 'error' | 'warn'; message: string }

/** Every SAC complaint across the lines, numbered so the form can point at one. */
export function sacIssuesFor(lines: { description?: string; sacCode?: string | null }[]): LineSacIssue[] {
  const out: LineSacIssue[] = []
  lines.forEach((l, i) => {
    const description = l.description ?? ''
    for (const issue of validateSac(l.sacCode)) {
      out.push({ line: i + 1, description, ...issue })
    }
    const mismatch = sacLooksWrongForDescription(description, l.sacCode)
    if (mismatch) out.push({ line: i + 1, description, ...mismatch })
  })
  return out
}

export function invoiceCurrency(taxMode: string, customerCurrency: string): string {
  return taxMode === 'EXPORT' ? (customerCurrency || 'USD') : 'INR'
}


export interface InvoiceLineInput {
  description: string
  detail?: string
  serviceItemId?: string | null
  sacCode?: string
  quantity: string
  rate: string
  discountPct?: string
  gstRatePct?: string
  incomeAccountCode?: string
}

export interface CreateInvoiceInput {
  customerId: string
  projectId?: string
  date: string
  dueDate?: string
  customerRef?: string
  milestone?: string
  tdsSection?: '194J' | '194C' | null
  lines: InvoiceLineInput[]
}

/**
 * Drafts carry a placeholder number. The real one is allocated at SEND time, so an
 * abandoned draft never punches a gap in the GST series — gaps have to be explainable
 * (docs/03 §2.1), and the cheapest way to guarantee that is not to create them.
 */
const draftNumber = (id: string) => `DRAFT-${id.slice(-10)}`
export const isDraftNumber = (n: string) => n.startsWith('DRAFT-')

async function loadCustomerAndMode(companyId: string, customerId: string) {
  const [company, customer] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
    prisma.customer.findFirst({ where: { id: customerId, companyId } }),
  ])
  if (!customer) throw new NotFound('Customer not found')

  const taxMode = resolveTaxMode(
    { stateCode: company.stateCode },
    { country: customer.country, stateCode: customer.stateCode, customerType: customer.customerType },
  )
  return { company, customer, taxMode }
}

function toLineInputs(lines: InvoiceLineInput[]): LineInput[] {
  return lines.map((l) => ({
    description: l.description,
    sacCode: l.sacCode ?? null,
    quantity: new Decimal(l.quantity),
    rate: new Decimal(l.rate),
    discountPct: l.discountPct ? new Decimal(l.discountPct) : ZERO,
    gstRatePct: new Decimal(l.gstRatePct ?? '18'),
  }))
}

/** Everything the form needs to render totals live, without saving. */
export async function previewInvoice(ctx: RequestContext, input: CreateInvoiceInput) {
  const { company, customer, taxMode } = await loadCustomerAndMode(ctx.companyId, input.customerId)
  const date = new Date(input.date)
  const fy = await resolveFy(ctx.companyId, date)
  // what this entity would actually issue, which decides both the LUT pill and the number
  const docType = docTypeFor(company.gstRegistrationType, taxMode)

  const totals = computeInvoice(toLineInputs(input.lines), taxMode)
  const tds = computeInvoiceTds({
    taxableValue: totals.taxableValue,
    grandTotal: totals.grandTotal,
    section: input.tdsSection ?? null,
    ratePct: defaultRateFor(input.tdsSection ?? null),
    mode: taxMode,
  })

  return {
    taxMode,
    placeOfSupply: taxMode === 'EXPORT' ? '96' : (customer.stateCode ?? company.stateCode),
    placeOfSupplyLabel: placeOfSupplyLabel(taxMode, customer.stateCode),
    currency: invoiceCurrency(taxMode, customer.currency),
    totals,
    tds,
    // 🔴 docs/82 §4 — not for a bill of supply: there is no zero-rating without a rate
    requiresLut: requiresLut(taxMode) && carriesTax(docType),
    // surfaced on the form so a wrong SAC is caught before the invoice is numbered, not
    // after it has been sent and reported in GSTR-1
    sacIssues: sacIssuesFor(input.lines),
    nextNumber: await peekNextNumber(prisma, {
      companyId: ctx.companyId,
      financialYearId: fy.id,
      docType,
      fyLabel: fy.label,
    }),
  }
}

export async function createInvoice(ctx: RequestContext, input: CreateInvoiceInput) {
  assertCan(ctx.role, 'invoices', 'write')
  if (input.lines.length === 0) throw new AppError('An invoice needs at least one line')

  const { company, customer, taxMode } = await loadCustomerAndMode(ctx.companyId, input.customerId)
  assertMayChargeGst(company.gstRegistrationType, input.lines)
  const date = new Date(input.date)
  const fy = await assertPostable(ctx.companyId, date)

  const totals = computeInvoice(toLineInputs(input.lines), taxMode)
  const tds = computeInvoiceTds({
    taxableValue: totals.taxableValue,
    grandTotal: totals.grandTotal,
    section: input.tdsSection ?? null,
    ratePct: defaultRateFor(input.tdsSection ?? null),
    mode: taxMode,
  })

  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : new Date(date.getTime() + (customer.paymentTermDays ?? company.defaultPaymentDays) * 86_400_000)

  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        companyId: ctx.companyId,
        financialYearId: fy.id,
        customerId: customer.id,
        projectId: input.projectId,
        docType: docTypeFor(company.gstRegistrationType, taxMode),
        number: `DRAFT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        seq: 0,
        date,
        dueDate,
        customerRef: input.customerRef,
        milestone: input.milestone,
        taxMode,
        placeOfSupply: taxMode === 'EXPORT' ? '96' : (customer.stateCode ?? company.stateCode),
        currency: invoiceCurrency(taxMode, customer.currency),
        taxableValue: totals.taxableValue.toFixed(2),
        cgst: totals.cgst.toFixed(2),
        sgst: totals.sgst.toFixed(2),
        igst: totals.igst.toFixed(2),
        roundOff: totals.roundOff.toFixed(2),
        grandTotal: totals.grandTotal.toFixed(2),
        tdsSection: tds.section,
        tdsRatePct: tds.section ? tds.ratePct.toFixed(2) : null,
        tdsAmount: tds.tdsAmount.toFixed(2),
        netPayable: tds.netPayable.toFixed(2),
        status: 'DRAFT',
        lines: {
          create: totals.lines.map((l, i) => ({
            position: i + 1,
            description: l.description,
            detail: input.lines[i].detail,
            serviceItemId: input.lines[i].serviceItemId,
            sacCode: l.sacCode,
            quantity: l.quantity.toFixed(3),
            rate: l.rate.toFixed(2),
            discountPct: (l.discountPct ?? ZERO).toFixed(2),
            taxableValue: l.taxableValue.toFixed(2),
            gstRatePct: l.gstRatePct.toFixed(2),
            cgst: l.cgst.toFixed(2),
            sgst: l.sgst.toFixed(2),
            igst: l.igst.toFixed(2),
          })),
        },
      },
      include: { lines: true },
    })
    // now that we have an id, give it a stable, readable draft marker
    const withMarker = await tx.invoice.update({ where: { id: created.id }, data: { number: draftNumber(created.id) } })
    await audit(ctx, { entity: 'Invoice', entityId: created.id, action: 'CREATE', after: { total: totals.grandTotal.toFixed(2), taxMode } }, tx)
    return { ...created, number: withMarker.number }
  })

  return invoice
}

/**
 * Edit a draft — docs/70.
 *
 * Until now a wrong draft had to be cancelled and re-raised. The numbering was safe either
 * way, because a draft has no number; what was not safe was the habit, since cancelling is
 * the act this system reserves for documents that have been ISSUED, and performing it on a
 * typo teaches that a cancellation means nothing much.
 *
 * 🔴 Only a DRAFT, and the check is the status rather than the number. `isDraftNumber` exists
 * and would have been the obvious thing to ask; it is a rendering detail, and a document that
 * has been sent and then cancelled still has a real number and must not be editable either.
 *
 * 🔴 Everything is recomputed, not patched. Changing the customer changes the tax mode, the
 * place of supply, the currency and the document TYPE — a domestic draft re-pointed at a
 * foreign client is an export invoice, drawn from a different series, needing an LUT. Copying
 * the new customer's id over the old one and leaving the rest would produce a draft that is
 * internally impossible, and nothing downstream would question it.
 */
export async function updateInvoiceDraft(ctx: RequestContext, invoiceId: string, input: CreateInvoiceInput) {
  assertCan(ctx.role, 'invoices', 'write')
  if (input.lines.length === 0) throw new AppError('An invoice needs at least one line')

  const existing = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    include: { lines: true },
  })
  if (!existing) throw new NotFound('Invoice not found')
  if (existing.status !== 'DRAFT') {
    throw new AppError(
      `${existing.number} has been issued — it cannot be edited. Raise a credit or debit note against it, ` +
      'or cancel it and raise a new one.',
    )
  }

  const { company, customer, taxMode } = await loadCustomerAndMode(ctx.companyId, input.customerId)
  const date = new Date(input.date)
  /**
   * 🔴 The financial year is re-resolved from the new date, not carried over.
   *
   * A draft moved across 1 April keeps its old `financialYearId` under any patch-the-fields
   * edit, and `sendInvoice` takes the number from the series for THAT year — so a draft dated
   * April 2027 would be numbered out of the 2026-27 series, out of order, in a year it does
   * not belong to. Nothing downstream would notice: the number is well-formed, the series is
   * real, and the gap only becomes visible when somebody reconciles the register.
   */
  const fy = await assertPostable(ctx.companyId, date)

  const totals = computeInvoice(toLineInputs(input.lines), taxMode)
  const tds = computeInvoiceTds({
    taxableValue: totals.taxableValue,
    grandTotal: totals.grandTotal,
    section: input.tdsSection ?? null,
    ratePct: defaultRateFor(input.tdsSection ?? null),
    mode: taxMode,
  })

  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : new Date(date.getTime() + (customer.paymentTermDays ?? company.defaultPaymentDays) * 86_400_000)

  return prisma.$transaction(async (tx) => {
    // a draft's lines are referenced by nothing — no journal line, no return, no document
    await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } })

    const updated = await tx.invoice.update({
      where: { id: existing.id },
      data: {
        financialYearId: fy.id,
        customerId: customer.id,
        projectId: input.projectId ?? null,
        docType: docTypeFor(company.gstRegistrationType, taxMode),
        date,
        dueDate,
        customerRef: input.customerRef ?? null,
        milestone: input.milestone ?? null,
        taxMode,
        placeOfSupply: taxMode === 'EXPORT' ? '96' : (customer.stateCode ?? company.stateCode),
        currency: invoiceCurrency(taxMode, customer.currency),
        taxableValue: totals.taxableValue.toFixed(2),
        cgst: totals.cgst.toFixed(2),
        sgst: totals.sgst.toFixed(2),
        igst: totals.igst.toFixed(2),
        roundOff: totals.roundOff.toFixed(2),
        grandTotal: totals.grandTotal.toFixed(2),
        tdsSection: tds.section,
        tdsRatePct: tds.section ? tds.ratePct.toFixed(2) : null,
        tdsAmount: tds.tdsAmount.toFixed(2),
        netPayable: tds.netPayable.toFixed(2),
        lines: {
          create: totals.lines.map((l, i) => ({
            position: i + 1,
            description: l.description,
            detail: input.lines[i].detail,
            serviceItemId: input.lines[i].serviceItemId,
            sacCode: l.sacCode,
            quantity: l.quantity.toFixed(3),
            rate: l.rate.toFixed(2),
            discountPct: (l.discountPct ?? ZERO).toFixed(2),
            taxableValue: l.taxableValue.toFixed(2),
            gstRatePct: l.gstRatePct.toFixed(2),
            cgst: l.cgst.toFixed(2),
            sgst: l.sgst.toFixed(2),
            igst: l.igst.toFixed(2),
          })),
        },
      },
      include: { lines: true },
    })

    await audit(ctx, {
      entity: 'Invoice', entityId: existing.id, action: 'UPDATE',
      before: {
        total: existing.grandTotal.toString(), taxMode: existing.taxMode,
        date: existing.date.toISOString().slice(0, 10), lines: existing.lines.length,
      },
      after: {
        total: totals.grandTotal.toFixed(2), taxMode,
        date: date.toISOString().slice(0, 10), lines: updated.lines.length,
      },
    }, tx)

    return updated
  })
}

/**
 * Send: allocate the real number, guard the LUT, post to the ledger, freeze the document.
 * 🔴 This is the only place an invoice number is created.
 */
export async function sendInvoice(ctx: RequestContext, invoiceId: string) {
  assertCan(ctx.role, 'invoices.send', 'approve')

  const sent = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id: invoiceId, companyId: ctx.companyId },
      include: { lines: { include: { serviceItem: true } }, financialYear: true, customer: true },
    })
    if (!inv) throw new NotFound('Invoice not found')
    if (inv.status !== 'DRAFT') throw new AppError(`Invoice ${inv.number} has already been sent`)

    await assertPostable(ctx.companyId, inv.date, tx)

    // 🔴 hard block — no zero-rated export without a LUT covering this financial year
    const lutId = await resolveLutForInvoice(tx, {
      companyId: ctx.companyId,
      taxMode: inv.taxMode,
      fyLabel: inv.financialYear.label,
      docType: inv.docType,
    })

    const { number, seq } = await allocateNumber(tx, {
      companyId: ctx.companyId,
      financialYearId: inv.financialYearId,
      docType: inv.docType,
      fyLabel: inv.financialYear.label,
    })

    /**
     * 🔴 docs/67 — `ServiceItem.incomeAccountId` is an account ID, and this fed it to
     * `revenueFromLines`, which wants a CODE.
     *
     * It had been that way since docs/34 and had never once fired, because nothing in the
     * system could set the field: the catalogue was seeded with it null and had no screen.
     * The moment a service item was given an income account, sending any invoice using it
     * failed with "Chart of accounts is missing: cmuu0oza1001…" — the id, presented as a code.
     *
     * A field nothing can set is a field nothing exercises.
     */
    const itemAccountIds = [...new Set(
      inv.lines.map((l) => l.serviceItem?.incomeAccountId).filter(Boolean) as string[],
    )]
    const itemAccounts = itemAccountIds.length
      ? await tx.account.findMany({
          where: { id: { in: itemAccountIds }, companyId: ctx.companyId },
          select: { id: true, code: true },
        })
      : []
    const codeById = new Map(itemAccounts.map((a) => [a.id, a.code]))

    const revenueByAccount = revenueFromLines(
      inv.lines.map((l) => ({
        taxableValue: new Decimal(l.taxableValue.toString()),
        incomeAccountCode: l.serviceItem?.incomeAccountId
          ? codeById.get(l.serviceItem.incomeAccountId) ?? null
          : null,
      })),
      '4010',
    )

    const postings = postInvoice({
      number,
      customerId: inv.customerId,
      projectId: inv.projectId,
      grandTotal: new Decimal(inv.grandTotal.toString()),
      cgst: new Decimal(inv.cgst.toString()),
      sgst: new Decimal(inv.sgst.toString()),
      igst: new Decimal(inv.igst.toString()),
      roundOff: new Decimal(inv.roundOff.toString()),
      revenueByAccount,
    })

    await postJournal(ctx, {
      date: inv.date,
      narration: `Invoice ${number}`,
      sourceType: 'INVOICE',
      sourceId: inv.id,
      postings,
    }, tx)

    const sent = await tx.invoice.update({
      where: { id: inv.id },
      data: {
        number, seq, lutId, status: 'SENT', sentAt: new Date(),
        // 🔴 Freeze the bill-to details at the moment of issue. From here the document is
        // fixed: correcting the customer's address tomorrow must not rewrite the invoice
        // the client is holding today, and the GSTIN here is what goes into GSTR-1 for this
        // period, so it cannot move either.
        billToName: inv.customer.name,
        billToAddress: inv.customer.billingAddress ?? undefined,
        billToGstin: inv.customer.gstin,
        billToStateCode: inv.customer.stateCode,
        billToCountry: inv.customer.country,
      },
    })
    await audit(ctx, { entity: 'Invoice', entityId: inv.id, action: 'APPROVE', before: { number: inv.number, status: inv.status }, after: { number, status: 'SENT' } }, tx)
    return sent
  })

  /**
   * 🔴 docs/59 — the issued document is archived AFTER the transaction, and a failure here
   * does not fail the send.
   *
   * Rendering launches a browser. Doing it inside the transaction would hold a database
   * write lock open for a second or more per invoice; doing it at all as a precondition
   * would mean a company that cannot bill because a PDF renderer is unwell. The invoice is
   * issued either way, and `unarchivedInvoices` names the ones with no copy on file.
   */
  await archiveIssuedDocument(ctx, {
    // 🔴 docs/82 §5 — a bill of supply is archived as what it IS. Filed under TAX_INVOICE it
    // would be indistinguishable later from a document this entity may not legally issue.
    kind: sent.docType === 'BILL_OF_SUPPLY' ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE',
    entityType: 'Invoice', entityId: sent.id,
    /**
     * 🔴 docs/83 §6 — the number goes through `pdfFilename`, it is not interpolated.
     *
     * `safeLabel` in the attachment store strips anything that could matter if the name were
     * ever read as a path, and that includes everything before the last `/`. A number of
     * `ADP/26-27/0029` was stored as `0029.pdf` — lossy but survivable — and the moment the
     * series pattern became `{SEQ}/ADP/{FY}` the SAME invoice stored as `26-27.pdf`, which
     * is the label every invoice in the year would carry. `pdfFilename` turns the slashes
     * into dashes first, so what is kept is the whole number.
     */
    filename: pdfFilename(sent.number ?? 'invoice'),
    render: () => renderInvoiceHtml(ctx.companyId, sent.id),
  })

  return sent
}

/** Cancel keeps the number — gaps in a GST series must be explainable. */
export async function cancelInvoice(ctx: RequestContext, invoiceId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'invoices.cancel', 'approve')
  if (!reason.trim()) throw new AppError('A cancellation reason is required')

  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId: ctx.companyId } })
    if (!inv) throw new NotFound('Invoice not found')
    if (inv.status === 'CANCELLED') throw new AppError('Already cancelled')
    if (new Decimal(inv.amountReceived.toString()).gt(0))
      throw new AppError('Cannot cancel an invoice with receipts against it — raise a credit note instead')

    if (inv.status !== 'DRAFT') {
      const entry = await tx.journalEntry.findFirst({ where: { companyId: ctx.companyId, sourceType: 'INVOICE', sourceId: inv.id } })
      if (entry) await reverseJournal(ctx, entry.id, on, reason, tx)
    }

    const cancelled = await tx.invoice.update({
      where: { id: inv.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    })
    await audit(ctx, { entity: 'Invoice', entityId: inv.id, action: 'CANCEL', before: { status: inv.status }, after: { status: 'CANCELLED', reason } }, tx)
    return cancelled
  })
}
