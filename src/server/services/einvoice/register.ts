import { prisma } from '@/server/db'
import { Decimal } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { NotFound } from '@/server/errors'
import { eInvoicingEnabled } from './applicability'
import { buildEInvoicePayload, validateEInvoice, type EInvoiceInput, type EInvoiceLine, type ValidationIssue } from './payload'
import { irpAdapter, EInvoiceError, canCancel, cancellableUntil } from './adapter'

interface AddressJson { line1?: string; line2?: string; city?: string; pincode?: string; state?: string }

function addr(json: unknown): { line1: string; line2: string | null; city: string; pincode: string | null } {
  const a = (json ?? {}) as AddressJson
  return {
    line1: a.line1 ?? '',
    line2: a.line2 ?? null,
    city: a.city ?? '',
    pincode: a.pincode ?? null,
  }
}

/** Assemble the IRP input from a stored invoice. Pure mapping — no decisions. */
export async function eInvoiceInputFor(ctx: RequestContext, invoiceId: string): Promise<EInvoiceInput> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    include: { customer: true, lines: { orderBy: { position: 'asc' } }, company: true },
  })
  if (!inv) throw new NotFound('Invoice not found')

  const sellerAddr = addr(inv.company.registeredAddress)
  const buyerAddr = addr(inv.customer.billingAddress)

  const lines: EInvoiceLine[] = inv.lines.map((l, i) => {
    const taxable = new Decimal(l.taxableValue.toString())
    const cgst = new Decimal(l.cgst.toString())
    const sgst = new Decimal(l.sgst.toString())
    const igst = new Decimal(l.igst.toString())
    return {
      slNo: i + 1,
      description: l.description,
      // Adpedia sells services only; the SAC in the 99xxxx range is what says so
      isService: true,
      hsnOrSac: l.sacCode,
      quantity: new Decimal(l.quantity.toString()),
      unit: 'OTH',
      unitPrice: new Decimal(l.rate.toString()),
      taxableValue: taxable,
      gstRatePct: new Decimal(l.gstRatePct.toString()),
      cgst, sgst, igst,
      // there is no stored line total — it is the parts, which is also exactly what the
      // IRP cross-checks TotItemVal against
      total: taxable.plus(cgst).plus(sgst).plus(igst),
    }
  })

  return {
    docType: 'INV',
    number: inv.number,
    date: inv.date,
    taxMode: inv.taxMode as 'INTRA' | 'INTER' | 'EXPORT',
    // Adpedia exports under LUT, so without payment of tax
    exportWithPayment: false,
    reverseCharge: false,
    seller: {
      gstin: inv.company.gstin,
      legalName: inv.company.legalName,
      address1: sellerAddr.line1, address2: sellerAddr.line2,
      location: sellerAddr.city, pincode: sellerAddr.pincode,
      stateCode: inv.company.stateCode,
    },
    buyer: {
      gstin: inv.customer.gstin,
      legalName: inv.customer.name,
      address1: buyerAddr.line1, address2: buyerAddr.line2,
      location: buyerAddr.city, pincode: buyerAddr.pincode,
      stateCode: inv.customer.stateCode,
    },
    lines,
    taxableValue: new Decimal(inv.taxableValue.toString()),
    cgst: new Decimal(inv.cgst.toString()),
    sgst: new Decimal(inv.sgst.toString()),
    igst: new Decimal(inv.igst.toString()),
    grandTotal: new Decimal(inv.grandTotal.toString()),
    currency: inv.currency,
    countryCode: inv.customer.country === 'IN' ? null : inv.customer.country,
  }
}

/**
 * Dry run — what the IRP would say, without asking it.
 *
 * Available regardless of whether e-invoicing applies, because it is the cheapest way to
 * find out whether the master data would survive the mandate: a missing buyer PIN or a
 * 4-digit SAC is a five-minute fix today and a blocked invoice on the day it matters.
 */
export async function previewEInvoice(ctx: RequestContext, invoiceId: string): Promise<{
  issues: ValidationIssue[]
  payload: Record<string, unknown>
  ready: boolean
}> {
  assertCan(ctx.role, 'invoices', 'read')
  const input = await eInvoiceInputFor(ctx, invoiceId)
  const issues = validateEInvoice(input)
  return { issues, payload: buildEInvoicePayload(input), ready: issues.length === 0 }
}

/**
 * Register an invoice with the IRP.
 *
 * 🔴 Two gates, both hard. The company must actually be liable — reading the ledger, not a
 * setting — and the integration must be explicitly switched on. An IRN is a government
 * record of a document; generating one for a taxpayer outside the mandate is not a
 * harmless dry run.
 */
export async function registerEInvoice(ctx: RequestContext, invoiceId: string) {
  assertCan(ctx.role, 'invoices', 'write')

  const gate = await eInvoicingEnabled(ctx)
  if (!gate.enabled) throw new EInvoiceError(gate.reason)

  const existing = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    select: { irn: true, number: true, status: true },
  })
  if (!existing) throw new NotFound('Invoice not found')
  if (existing.irn) {
    throw new EInvoiceError(`${existing.number} already carries an IRN. An invoice is registered once — issue a credit note instead.`)
  }

  const input = await eInvoiceInputFor(ctx, invoiceId)
  const issues = validateEInvoice(input)
  if (issues.length > 0) {
    throw new EInvoiceError(`${existing.number} would be rejected by the IRP`, issues)
  }

  const payload = buildEInvoicePayload(input)
  const ack = await irpAdapter().generate(payload)

  const updated = await prisma.invoice.update({
    where: { companyId: ctx.companyId, id: invoiceId },
    // 🔴 docs/75 — record WHICH IRP said so. A mock registration is otherwise indistinguishable
    // from a real one, in the same four columns, and the document would print either.
    data: {
      irn: ack.irn, ackNo: ack.ackNo, ackDate: ack.ackDate, signedQr: ack.signedQr,
      irpSource: irpAdapter().name,
    },
  })

  await audit(ctx, {
    entity: 'Invoice', entityId: invoiceId, action: 'UPDATE',
    after: { irn: ack.irn, ackNo: ack.ackNo, adapter: irpAdapter().name },
  })

  return { irn: ack.irn, ackNo: ack.ackNo, ackDate: ack.ackDate, cancellableUntil: cancellableUntil(ack.ackDate), invoice: updated }
}

/**
 * Cancel on the IRP.
 *
 * 🔴 The window is 24 hours from the acknowledgement, and it is absolute. After that the
 * only lawful route is a credit note — which is an accounting event with its own GSTR-1
 * row, not an undo. Checking it here means the person is told that before they try, rather
 * than by a rejection they have to interpret.
 */
export async function cancelEInvoice(ctx: RequestContext, invoiceId: string, reason: '1' | '2' | '3' | '4', remark: string) {
  assertCan(ctx.role, 'invoices', 'write')

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    select: { irn: true, ackDate: true, number: true },
  })
  if (!inv) throw new NotFound('Invoice not found')
  if (!inv.irn || !inv.ackDate) throw new EInvoiceError(`${inv.number} has no IRN to cancel`)

  if (!canCancel(inv.ackDate)) {
    throw new EInvoiceError(
      `The 24-hour cancellation window for ${inv.number} closed at ${cancellableUntil(inv.ackDate).toISOString()}. Raise a credit note instead — it cannot be cancelled on the IRP now.`,
    )
  }

  await irpAdapter().cancel(inv.irn, reason, remark)

  const updated = await prisma.invoice.update({
    where: { companyId: ctx.companyId, id: invoiceId },
    data: { irn: null, ackNo: null, ackDate: null, signedQr: null, irpSource: null, status: 'CANCELLED' },
  })

  await audit(ctx, {
    entity: 'Invoice', entityId: invoiceId, action: 'UPDATE',
    after: { cancelledIrn: inv.irn, reason, remark },
  })
  return updated
}
