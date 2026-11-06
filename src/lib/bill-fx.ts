import { Decimal, ZERO, round2 } from '@/lib/money'
import { toInr } from '@/lib/fx'

/**
 * docs/93 — a vendor bill in a foreign currency, in rupees.
 *
 * Pure, so the arithmetic is testable without a database and shared by the bill, the approval
 * and the payment — the three places that each need "what is this bill worth in the books".
 */

export interface BillParts {
  /** cost account code → amount in the bill's currency */
  costByAccount: Record<string, Decimal>
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
}

export interface BillInr {
  costByAccount: Record<string, Decimal>
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  /** the sum of the converted parts — what payables is credited, to the paisa */
  grand: Decimal
}

/** Every cost account and tax head converted on its own; the total is what they add up to. */
export function billInr(parts: BillParts, rate: Decimal.Value): BillInr {
  const costByAccount: Record<string, Decimal> = {}
  let grand = ZERO
  for (const [code, amount] of Object.entries(parts.costByAccount)) {
    costByAccount[code] = toInr(amount, rate)
    grand = grand.plus(costByAccount[code])
  }
  const cgst = toInr(parts.cgst, rate), sgst = toInr(parts.sgst, rate), igst = toInr(parts.igst, rate)
  return { costByAccount, cgst, sgst, igst, grand: grand.plus(cgst).plus(sgst).plus(igst) }
}

/**
 * What a payment still has to clear of payables, in rupees, so that after it payables holds
 * exactly the share of the bill that is still unpaid.
 *
 * `owedTotalDoc` is what the vendor is owed in the bill's currency (the bill less its TDS);
 * `payableInr` is what payables carries for it in rupees after TDS; `paidAfter` is the cumulative
 * payment including this one; `alreadyClearedInr` is what earlier payments actually cleared —
 * read from the journal, so a cancelled and re-entered payment cannot leave drift behind.
 *
 * 🔴 A target, not a per-payment rounding: rounding each part separately can leave a paisa in
 * 2000 when the last payment closes the bill. The last one settles exactly what is left.
 */
export function clearedInr(payableInr: Decimal, owedTotalDoc: Decimal, paidAfter: Decimal, alreadyClearedInr: Decimal, settles: boolean): Decimal {
  if (owedTotalDoc.lte(0)) return ZERO
  const target = settles || paidAfter.gte(owedTotalDoc) ? payableInr : round2(payableInr.mul(paidAfter).div(owedTotalDoc))
  return target.minus(alreadyClearedInr)
}

/** The rupees a bill still carries in payables, in proportion to what is still owed in its own currency. */
export function carryingInr(payableInr: Decimal, owedDoc: Decimal, outstandingDoc: Decimal): Decimal {
  if (owedDoc.lte(0) || outstandingDoc.lte(0)) return ZERO
  return outstandingDoc.gte(owedDoc) ? payableInr : round2(payableInr.mul(outstandingDoc).div(owedDoc))
}

/**
 * What payables carries for a bill's still-unpaid share, in rupees. A rupee bill is its own
 * figure; a foreign one is the stored rupee total less the rupee TDS, in proportion to what is
 * still owed in its own currency. Every report that adds bills into a rupee total goes through
 * here, so it agrees with 2000 rather than adding the bill's own currency to rupees.
 */
export function outstandingInr(bill: {
  currency: string
  grandTotal: Decimal.Value; tdsAmount: Decimal.Value; amountPaid: Decimal.Value
  grandTotalInr: Decimal.Value | null; tdsAmountInr: Decimal.Value | null
}, outstandingDoc: Decimal): Decimal {
  if (bill.currency === 'INR' || bill.grandTotalInr == null) return outstandingDoc
  const payable = new Decimal(bill.grandTotalInr.toString()).minus((bill.tdsAmountInr ?? 0).toString())
  const owedTotal = new Decimal(bill.grandTotal.toString()).minus(bill.tdsAmount.toString())
  return carryingInr(payable, owedTotal, outstandingDoc)
}
