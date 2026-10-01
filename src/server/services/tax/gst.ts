import { Decimal, round2, round0, sumBy, ZERO } from '@/lib/money'
import type { TaxMode } from '@prisma/client'
import { isZeroRated } from './tax-mode'

export interface LineInput {
  description: string
  sacCode?: string | null
  quantity: Decimal
  rate: Decimal
  discountPct?: Decimal
  gstRatePct: Decimal
}

export interface ComputedLine extends LineInput {
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  total: Decimal
}

export interface InvoiceTotals {
  lines: ComputedLine[]
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  taxTotal: Decimal
  rawTotal: Decimal
  roundOff: Decimal
  grandTotal: Decimal
}

/**
 * 🔴 Round per line, THEN sum. docs/12 §3.2.
 *
 * Each line's tax is printed on the invoice and has to be right on its own, so the
 * line is the unit of rounding. Summing first and rounding once gives a different
 * — and wrong — answer. tests/money.test.ts pins the divergent case.
 */
export function computeLine(line: LineInput, mode: TaxMode): ComputedLine {
  const discount = line.discountPct ?? ZERO
  const gross = line.rate.mul(line.quantity)
  const taxableValue = round2(gross.mul(new Decimal(1).minus(discount.div(100))))

  if (isZeroRated(mode)) {
    return { ...line, taxableValue, cgst: ZERO, sgst: ZERO, igst: ZERO, total: taxableValue }
  }

  const tax = round2(taxableValue.mul(line.gstRatePct).div(100))

  if (mode === 'INTRA') {
    // Halve once and derive the other half by subtraction, so an odd paisa
    // lands on SGST rather than vanishing or being invented.
    const cgst = round2(tax.div(2))
    const sgst = round2(tax.minus(cgst))
    return { ...line, taxableValue, cgst, sgst, igst: ZERO, total: taxableValue.plus(cgst).plus(sgst) }
  }

  // INTER and SEZ_WITH_PAY both charge IGST
  return { ...line, taxableValue, cgst: ZERO, sgst: ZERO, igst: tax, total: taxableValue.plus(tax) }
}

export function computeInvoice(inputs: LineInput[], mode: TaxMode): InvoiceTotals {
  const lines = inputs.map((l) => computeLine(l, mode))

  const taxableValue = sumBy(lines, (l) => l.taxableValue)
  const cgst = sumBy(lines, (l) => l.cgst)
  const sgst = sumBy(lines, (l) => l.sgst)
  const igst = sumBy(lines, (l) => l.igst)
  const taxTotal = cgst.plus(sgst).plus(igst)

  const rawTotal = taxableValue.plus(taxTotal)
  const grandTotal = round0(rawTotal)          // invoices settle in whole rupees
  const roundOff = grandTotal.minus(rawTotal)  // stored explicitly, never implicit

  return { lines, taxableValue, cgst, sgst, igst, taxTotal, rawTotal, roundOff, grandTotal }
}

export interface SacSummaryRow {
  sacCode: string
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  total: Decimal
}

/** GSTR-1 wants this whether or not the invoice prints it. docs/03 §7.2. */
export function sacSummary(lines: ComputedLine[]): SacSummaryRow[] {
  const map = new Map<string, SacSummaryRow>()
  for (const l of lines) {
    const key = l.sacCode ?? '—'
    const row = map.get(key) ?? { sacCode: key, taxableValue: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, total: ZERO }
    row.taxableValue = row.taxableValue.plus(l.taxableValue)
    row.cgst = row.cgst.plus(l.cgst)
    row.sgst = row.sgst.plus(l.sgst)
    row.igst = row.igst.plus(l.igst)
    row.total = row.total.plus(l.total)
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => a.sacCode.localeCompare(b.sacCode))
}
