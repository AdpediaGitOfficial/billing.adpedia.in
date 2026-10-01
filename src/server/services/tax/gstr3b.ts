import { Decimal, ZERO } from '@/lib/money'
import { gstPosition, outwardSupplies } from './gst-ledger'

/**
 * GSTR-3B — the monthly/quarterly summary return.
 *
 * Built from the ledger plus the invoice mix, and exported for the CA rather than filed.
 * Table numbering follows the current form; treat it as a mapping that the CA checks,
 * not as the authority.
 */
export interface Gstr3b {
  period: { label: string; from: Date; to: Date }
  /** 3.1(a) outward taxable supplies (other than zero-rated, nil-rated, exempted) */
  t31a: { taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal }
  /** 3.1(b) outward taxable supplies — zero rated */
  t31b: { taxable: Decimal; igst: Decimal }
  /** 3.1(d) inward supplies liable to reverse charge */
  t31d: { taxable: Decimal; igst: Decimal }
  /** 4(A) ITC available */
  t4a: { igst: Decimal; cgst: Decimal; sgst: Decimal; rcm: Decimal; total: Decimal }
  /** 4(B) ITC reversed */
  t4b: { total: Decimal }
  /** 4(C) net ITC available */
  t4c: Decimal
  /** 5.1 interest and late fee */
  t51: { interest: Decimal; lateFee: Decimal }
  /** 6.1 payment of tax */
  payable: { throughItc: Decimal; inCash: Decimal; rcmInCash: Decimal; total: Decimal }
  notes: string[]
}

export async function buildGstr3b(companyId: string, from: Date, to: Date, label: string): Promise<Gstr3b> {
  const [pos, supplies] = await Promise.all([
    gstPosition(companyId, from, to),
    outwardSupplies(companyId, from, to),
  ])

  const notes: string[] = []

  const outputTotal = pos.output.total
  const itcAvailable = pos.input.total
  const netItc = Decimal.max(itcAvailable, ZERO)

  // Output tax is settled with ITC first, the remainder in cash.
  const throughItc = Decimal.min(outputTotal, netItc)
  const inCash = Decimal.max(outputTotal.minus(netItc), ZERO)

  // 🔴 RCM is ALWAYS paid in cash — it can never be discharged with existing ITC.
  if (pos.rcm.payable.gt(0)) {
    notes.push('Reverse-charge liability must be paid in cash; it cannot be set off against ITC. The ITC on it is claimable in the same return.')
  }
  if (supplies.zeroRated.taxable.gt(0)) {
    notes.push('Zero-rated supplies are reported under 3.1(b). Under a LUT they carry no IGST; without one they must be reported with payment of IGST.')
  }
  if (itcAvailable.isZero()) {
    notes.push('No input tax credit in this period — vendor bills and expenses arrive in phase 3.')
  }

  return {
    period: { label, from, to },
    t31a: {
      taxable: supplies.taxable.taxable,
      igst: supplies.taxable.igst, cgst: supplies.taxable.cgst, sgst: supplies.taxable.sgst,
    },
    t31b: { taxable: supplies.zeroRated.taxable, igst: supplies.zeroRated.igst },
    t31d: { taxable: ZERO, igst: pos.rcm.payable },
    t4a: {
      igst: pos.input.igst, cgst: pos.input.cgst, sgst: pos.input.sgst,
      rcm: pos.rcm.itc, total: itcAvailable,
    },
    t4b: { total: ZERO },
    t4c: netItc,
    t51: { interest: ZERO, lateFee: ZERO },
    payable: { throughItc, inCash, rcmInCash: pos.rcm.payable, total: outputTotal.plus(pos.rcm.payable) },
    notes,
  }
}
