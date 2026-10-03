import { prisma } from '@/server/db'
import type { Tx } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'

/**
 * Kerala profession tax.
 *
 * Levied by the local body on HALF-YEARLY earnings, by slab, and payable twice a year
 * (Apr–Sep and Oct–Mar). It applies regardless of headcount — EPF needs 20 employees and
 * ESI needs 10, so neither touches Adpedia, but this one does (docs/04 §6).
 *
 * ⚠️ The slabs are the published Kerala half-yearly table and must still be confirmed with
 * the CA before the first deduction, like every other rate in this system. The local body
 * (municipality or panchayat) sets them under the Kerala Municipality Act, so they can
 * differ between local bodies — Chalakudy's schedule is the one that governs here.
 *
 * 🔴 Article 276(2) of the Constitution caps profession tax at ₹2,500 per person per YEAR
 * across all local bodies. The top slab is ₹1,250 a half-year, which reaches that ceiling
 * exactly — so any slab table that totals more than ₹2,500 over two halves is wrong on its
 * face, whatever a circular says. `assertWithinConstitutionalCap` below enforces it.
 */

/** Article 276(2) — the annual ceiling, which no state can exceed. */
export const ANNUAL_PT_CAP = new Decimal('2500')

export type HalfYear = 'H1' | 'H2'

/** H1 is Apr–Sep, H2 is Oct–Mar. */
export function halfYearOf(date: Date): HalfYear {
  const m = date.getUTCMonth() + 1
  return m >= 4 && m <= 9 ? 'H1' : 'H2'
}

/** Profession tax is deducted in the final month of its half-year, when it falls due. */
export function isDeductionMonth(month: number): boolean {
  return month === 9 || month === 3
}

export async function professionTaxFor(
  stateCode: string, halfYearEarnings: Decimal, onDate: Date, tx: Tx = prisma,
): Promise<{ amount: Decimal; slabLabel: string | null }> {
  const slabs = await tx.professionTaxSlab.findMany({
    where: {
      stateCode,
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
    },
    orderBy: { fromAmount: 'asc' },
  })
  if (slabs.length === 0) return { amount: ZERO, slabLabel: null }

  // 🔴 Match on the lower bound only — the HIGHEST slab whose floor the earnings reach.
  //
  // Testing `earnings >= from && earnings <= to` looks equivalent and is not. The published
  // table is written in whole rupees (…11999, then 12000…), so anything between the two —
  // ₹11,999.50 of half-year earnings, which a mid-month joiner produces routinely — matches
  // NO band and silently falls through to zero tax. The gap is invisible because a zero
  // deduction looks exactly like an employee below the first slab.
  let best: { amount: Decimal; label: string } | null = null
  for (const s of slabs) {
    const from = new Decimal(s.fromAmount.toString())
    if (halfYearEarnings.lt(from)) break          // ordered ascending, so nothing further fits
    const to = s.toAmount ? new Decimal(s.toAmount.toString()) : null
    best = {
      amount: new Decimal(s.amount.toString()),
      // 🔴 docs/57 — grouped. This label reaches a payslip, where "₹12500" reads as a
      // figure nobody checked and "₹1,25,000" reads as one somebody did.
      label: to
        ? `${formatINR(from, { decimals: false })}–${formatINR(to, { decimals: false })}`
        : `above ${formatINR(from, { decimals: false })}`,
    }
  }
  return best ? { amount: best.amount, slabLabel: best.label } : { amount: ZERO, slabLabel: null }
}

/**
 * Guard a slab table against the constitutional ceiling.
 *
 * Deducting more than ₹2,500 a year is not a rounding question — it is ultra vires, and the
 * employer is the one who withheld it. Cheap to check, so it is checked rather than assumed.
 */
export function assertWithinConstitutionalCap(topHalfYearlyAmount: Decimal): void {
  const annual = topHalfYearlyAmount.mul(2)
  if (annual.gt(ANNUAL_PT_CAP)) {
    throw new Error(
      `Profession tax slab of ₹${topHalfYearlyAmount.toFixed(0)} per half year totals ₹${annual.toFixed(0)} a year, above the ₹2,500 ceiling in Article 276(2).`,
    )
  }
}
