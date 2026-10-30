import type { DocType, GstRegType, TaxMode } from '@prisma/client'
import { AppError } from '@/server/errors'

/**
 * Which document an entity is ALLOWED to issue — docs/82 §5.
 *
 * 🔴 `gstRegistrationType` sat on `Company` for eighty-one modules and nothing read it. The
 * whole system assumed a registered supplier: output tax accounts, GSTR-1, QRMP periods, a
 * GSTIN printed on every document. An unregistered entity put through that path would have
 * issued a document headed **Tax Invoice**, carrying a GSTIN field, at 0% — wrong on its face
 * under rule 46, and not the document rule 49 requires.
 *
 * A bill of supply is not a tax invoice with the tax removed. It is a different document,
 * issued by a different kind of supplier, and the difference is what an assessment reads.
 */

/**
 * Registered at all — which decides whether the GST SCREENS mean anything.
 *
 * A composition taxpayer is registered: it files (CMP-08 and GSTR-4 rather than GSTR-1 and
 * 3B, which this system does not yet produce — noted in docs/82 §5).
 */
export function isGstRegistered(registration: GstRegType): boolean {
  return registration !== 'UNREGISTERED'
}

/**
 * 🔴 May COLLECT tax from the recipient — which is a narrower question, and the one that
 * decides what document is issued.
 *
 * Rule 49 names both cases: a person not registered, and a registered person **paying tax
 * under s.10**. A composition dealer is registered and files returns, and still may not collect
 * tax from its customer — s.10(4) — so it issues a bill of supply exactly as an unregistered
 * person does. Keying the document off "is registered" alone would hand a composition dealer a
 * tax invoice and invite it to charge tax it must absorb out of its own margin.
 */
export function mayCollectTax(registration: GstRegType): boolean {
  return registration === 'REGULAR'
}

export function docTypeFor(registration: GstRegType, taxMode: TaxMode): DocType {
  // 🔴 this decides BEFORE the tax mode does. A supplier who may not collect tax and is
  // exporting services is still issuing a bill of supply: zero-rating under LUT is something a
  // regular registered person does, and there is no LUT without that registration.
  if (!mayCollectTax(registration)) return 'BILL_OF_SUPPLY'
  return taxMode === 'EXPORT' ? 'EXPORT_INVOICE' : 'TAX_INVOICE'
}

/** Is this document one that carries tax at all? */
export function carriesTax(docType: DocType): boolean {
  return docType !== 'BILL_OF_SUPPLY'
}

/**
 * 🔴 Refused, not silently zeroed.
 *
 * Quietly dropping the rate would produce a correct document from an input that was wrong, and
 * leave somebody believing they had charged tax they had not — which they would then not have
 * collected, and would still owe nobody. Saying so is the only useful behaviour: collecting GST
 * without a registration is an offence under s.32(1), separately from whatever the document says.
 */
export function assertMayChargeGst(
  registration: GstRegType,
  lines: ReadonlyArray<{ gstRatePct?: string | number | null }>,
) {
  if (mayCollectTax(registration)) return
  const charged = lines.some((l) => Number(l.gstRatePct ?? 0) > 0)
  if (!charged) return

  throw new AppError(
    registration === 'COMPOSITION'
      ? 'A composition taxpayer may not collect GST from its customer — s.10(4). The tax is paid '
        + 'out of its own turnover, and its documents are bills of supply. Set the rate to 0.'
      : 'This entity is not registered for GST, so it cannot charge it — s.32(1). Its documents '
        + 'are bills of supply at nil rate. Register the entity first, or set the rate to 0.',
  )
}
