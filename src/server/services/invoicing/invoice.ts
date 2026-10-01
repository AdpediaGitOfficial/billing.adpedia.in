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
import { resolveLutForInvoice } from './lut'
import { validateSac, sacLooksWrongForDescription } from './sac'

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
  serviceItemId?: string
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
    requiresLut: requiresLut(taxMode),
    // surfaced on the form so a wrong SAC is caught before the invoice is numbered, not
    // after it has been sent and reported in GSTR-1
    sacIssues: sacIssuesFor(input.lines),
    nextNumber: await peekNextNumber(prisma, {
      companyId: ctx.companyId,
      financialYearId: fy.id,
      docType: taxMode === 'EXPORT' ? 'EXPORT_INVOICE' : 'TAX_INVOICE',
      fyLabel: fy.label,
    }),
  }
}

export async function createInvoice(ctx: RequestContext, input: CreateInvoiceInput) {
  assertCan(ctx.role, 'invoices', 'write')
  if (input.lines.length === 0) throw new AppError('An invoice needs at least one line')

  const { company, customer, taxMode } = await loadCustomerAndMode(ctx.companyId, input.customerId)
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
        docType: taxMode === 'EXPORT' ? 'EXPORT_INVOICE' : 'TAX_INVOICE',
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
 * Send: allocate the real number, guard the LUT, post to the ledger, freeze the document.
 * 🔴 This is the only place an invoice number is created.
 */
export async function sendInvoice(ctx: RequestContext, invoiceId: string) {
  assertCan(ctx.role, 'invoices.send', 'approve')

  return prisma.$transaction(async (tx) => {
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
    })

    const { number, seq } = await allocateNumber(tx, {
      companyId: ctx.companyId,
      financialYearId: inv.financialYearId,
      docType: inv.docType,
      fyLabel: inv.financialYear.label,
    })

    const revenueByAccount = revenueFromLines(
      inv.lines.map((l) => ({
        taxableValue: new Decimal(l.taxableValue.toString()),
        incomeAccountCode: l.serviceItem?.incomeAccountId ?? null,
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
