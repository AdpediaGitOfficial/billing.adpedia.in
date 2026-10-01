import { Decimal, round2, ZERO } from '@/lib/money'
import type { TaxMode } from '@prisma/client'
import { allowsTds } from './tax-mode'

export interface TdsOnInvoice {
  section: string | null
  ratePct: Decimal
  baseAmount: Decimal
  tdsAmount: Decimal
  netPayable: Decimal
}

/**
 * TDS the CUSTOMER is expected to deduct from us.
 *
 * Two things that are easy to get wrong:
 *  1. The base is the TAXABLE VALUE, excluding GST — CBDT Circular 23/2017, where
 *     GST is shown separately on the invoice.
 *  2. It is NOT posted when the invoice is raised. The customer may not deduct at
 *     all. This figure only prints on the PDF and feeds AR ageing; the ledger entry
 *     happens on receipt (docs/12 §2.4).
 */
export function computeInvoiceTds(args: {
  taxableValue: Decimal
  grandTotal: Decimal
  section: string | null
  ratePct: Decimal | null
  mode: TaxMode
}): TdsOnInvoice {
  const { taxableValue, grandTotal, section, ratePct, mode } = args

  // Overseas clients do not deduct Indian TDS.
  if (!section || !ratePct || !allowsTds(mode)) {
    return { section: null, ratePct: ZERO, baseAmount: ZERO, tdsAmount: ZERO, netPayable: grandTotal }
  }

  const tdsAmount = round2(taxableValue.mul(ratePct).div(100))
  return {
    section,
    ratePct,
    baseAmount: taxableValue,
    tdsAmount,
    netPayable: grandTotal.minus(tdsAmount),
  }
}

/** Default rates for the sections Adpedia's customers actually use. */
export const CUSTOMER_TDS_SECTIONS: { code: string; label: string; ratePct: string }[] = [
  { code: '194J', label: '194J — professional / technical fees', ratePct: '10' },
  { code: '194C', label: '194C — contract work', ratePct: '2' },
]

export function defaultRateFor(section: string | null): Decimal | null {
  const found = CUSTOMER_TDS_SECTIONS.find((s) => s.code === section)
  return found ? new Decimal(found.ratePct) : null
}
