import type { TaxMode } from '@prisma/client'
import { stateName } from '@/lib/indian-states'

export interface TaxModeCompany { stateCode: string }
export interface TaxModeCustomer {
  country: string
  stateCode: string | null
  customerType: 'B2B' | 'B2C' | 'SEZ' | 'EXPORT'
}

/**
 * 🔴 Derived, never chosen. docs/12 §3.1.
 *
 * Order matters: country is tested FIRST so a null stateCode on an overseas
 * customer can never compare equal to Adpedia's '32' and produce an intra-state
 * invoice for a Dubai client.
 */
export function resolveTaxMode(
  company: TaxModeCompany,
  customer: TaxModeCustomer,
  opts: { sezWithPayment?: boolean } = {},
): TaxMode {
  if (customer.country !== 'IN') return 'EXPORT'
  if (customer.customerType === 'SEZ') return opts.sezWithPayment ? 'SEZ_WITH_PAY' : 'SEZ_WITHOUT_PAY'
  if (customer.stateCode && customer.stateCode === company.stateCode) return 'INTRA'
  return 'INTER'
}

/** Zero-rated modes charge no GST and require a LUT (or payment of IGST). */
export function isZeroRated(mode: TaxMode): boolean {
  return mode === 'EXPORT' || mode === 'SEZ_WITHOUT_PAY'
}

/** Only these modes need a LUT on file for the invoice's financial year. */
export function requiresLut(mode: TaxMode): boolean {
  return isZeroRated(mode)
}

/** Indian clients deduct TDS; overseas clients do not. */
export function allowsTds(mode: TaxMode): boolean {
  return mode !== 'EXPORT'
}

/**
 * 🔴 The table moved to `lib/indian-states.ts` — four client forms needed it and could not
 * import from `server`, so each had written out a partial copy. Re-exported here because
 * this module is where the rest of the codebase has always asked for it.
 */
export { stateName, STATE_NAMES } from '@/lib/indian-states'

export function placeOfSupplyLabel(mode: TaxMode, stateCode: string | null): string {
  if (mode === 'EXPORT') return 'Outside India (96 – Other Country)'
  return `${stateName(stateCode)} (${stateCode})`
}

/** The banner shown on the invoice form — displayed, never offered as a choice. */
export function taxModeLabel(mode: TaxMode): string {
  switch (mode) {
    case 'INTRA': return 'Intra-state · CGST + SGST'
    case 'INTER': return 'Inter-state · IGST'
    case 'EXPORT': return 'Export of services · zero-rated under LUT'
    case 'SEZ_WITHOUT_PAY': return 'SEZ · zero-rated under LUT'
    case 'SEZ_WITH_PAY': return 'SEZ · with payment of IGST'
  }
}

/** GSTIN characters 1–2 are the state code. Used to cross-check what was typed. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null
  const code = gstin.slice(0, 2)
  return /^\d{2}$/.test(code) ? code : null
}
