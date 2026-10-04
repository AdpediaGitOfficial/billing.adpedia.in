/**
 * Statutory due dates, as pure functions.
 *
 * Kept separate from the data so each one can be tested on its own. Every rule here has an
 * exception that catches people out, and the exception is the reason the function exists —
 * a table of "7th of the month" would be wrong four times a year.
 */

export type Obligation =
  | 'TDS_DEPOSIT' | 'TDS_RETURN' | 'FORM_16A' | 'FORM_16'
  | 'GSTR1' | 'GSTR3B' | 'GST_PMT06' | 'GSTR9'
  | 'PROFESSION_TAX' | 'ADVANCE_TAX' | 'LUT_RENEWAL' | 'ITR'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 23, 59, 59))

/**
 * 🔴 TDS deposit: the 7th of the following month — except March, which is 30 April.
 *
 * March is the exception because the year has ended; the government allows the extra time to
 * close the books. Applying the 7th blindly makes every March deposit look three weeks late
 * and triggers a false interest calculation.
 */
export function tdsDepositDue(month: number, year: number): Date {
  if (month === 3) return utc(year, 4, 30)
  return month === 12 ? utc(year + 1, 1, 7) : utc(year, month + 1, 7)
}

/**
 * 🔴 TDS return: the last day of the month following the quarter — except Q4, which is
 * 31 May, not 30 April.
 *
 * Q1 Apr–Jun → 31 Jul · Q2 Jul–Sep → 31 Oct · Q3 Oct–Dec → 31 Jan · Q4 Jan–Mar → 31 May
 */
export function tdsReturnDue(quarter: 1 | 2 | 3 | 4, fyStartYear: number): Date {
  switch (quarter) {
    case 1: return utc(fyStartYear, 7, 31)
    case 2: return utc(fyStartYear, 10, 31)
    case 3: return utc(fyStartYear + 1, 1, 31)
    case 4: return utc(fyStartYear + 1, 5, 31)
  }
}

/** Form 16A follows its return by 15 days. */
export function form16aDue(quarter: 1 | 2 | 3 | 4, fyStartYear: number): Date {
  const d = tdsReturnDue(quarter, fyStartYear)
  return new Date(d.getTime() + 15 * 86_400_000)
}

/** Form 16 (salary) — 15 June following the financial year. */
export function form16Due(fyStartYear: number): Date {
  return utc(fyStartYear + 1, 6, 15)
}

/** GSTR-1: 11th of the following month, or the 13th after a quarter under QRMP. */
export function gstr1Due(periodEnd: Date, quarterly: boolean): Date {
  const y = periodEnd.getUTCFullYear(), m = periodEnd.getUTCMonth() + 1
  const day = quarterly ? 13 : 11
  return m === 12 ? utc(y + 1, 1, day) : utc(y, m + 1, day)
}

/**
 * GSTR-3B: the 20th of the following month.
 *
 * 🔴 Under QRMP it is the 22nd or the 24th depending on the STATE — Kerala is in the 24th
 * group. Using the 20th for a quarterly filer reports a deadline four days earlier than it
 * is, which is harmless; using it the other way round would not be.
 */
const QRMP_24TH_STATES = new Set([
  '29', '32', '33', '34', '35', '36', '37', '38', '30', '31', '27', '26', '24', '23', '22',
])

export function gstr3bDue(periodEnd: Date, quarterly: boolean, stateCode: string): Date {
  const y = periodEnd.getUTCFullYear(), m = periodEnd.getUTCMonth() + 1
  const day = quarterly ? (QRMP_24TH_STATES.has(stateCode) ? 24 : 22) : 20
  return m === 12 ? utc(y + 1, 1, day) : utc(y, m + 1, day)
}

/** PMT-06: under QRMP, tax for months 1 and 2 of a quarter is paid by the 25th. */
export function pmt06Due(month: number, year: number): Date {
  return month === 12 ? utc(year + 1, 1, 25) : utc(year, month + 1, 25)
}

/** GSTR-9 annual return — 31 December following the financial year. */
export function gstr9Due(fyStartYear: number): Date {
  return utc(fyStartYear + 1, 12, 31)
}

/** Kerala profession tax: H1 (Apr–Sep) by 31 August, H2 (Oct–Mar) by 28 February. */
export function professionTaxDue(half: 'H1' | 'H2', fyStartYear: number): Date {
  return half === 'H1' ? utc(fyStartYear, 8, 31) : utc(fyStartYear + 1, 2, 28)
}

/**
 * 🔴 Advance tax, for a company: 15% by 15 Jun, 45% by 15 Sep, 75% by 15 Dec, 100% by 15 Mar.
 *
 * The percentages are CUMULATIVE, not per instalment — by 15 September the total paid must
 * reach 45% of the year's liability, not 45% on top of June's 15%. Reading them as separate
 * instalments under-pays every quarter and accrues interest under s.234C.
 *
 * 🔴 `safeHarbourPct` is NOT a rounding of `cumulativePct`, and the two differ on purpose —
 * docs/71. The provisos to s.234C(1) say that no interest is charged for the first instalment
 * if at least **12%** has been paid by 15 June, and none for the second if at least **36%**
 * has been paid by 15 September. The shortfall that must be made up is still measured against
 * 15% and 45%; what the proviso forgives is the INTEREST on a near miss, and only for those
 * two. A system that charges interest from 15% has a plausible, legal-looking figure that is
 * simply wrong, and nobody checks a tax computation that looks reasonable.
 */
export const ADVANCE_TAX_SCHEDULE: {
  by: 'JUN' | 'SEP' | 'DEC' | 'MAR'
  cumulativePct: number
  /** below this, s.234C interest runs for the instalment; at or above it, none does */
  safeHarbourPct: number
  /**
   * 🔴 Months of interest, FIXED by the statute rather than counted from the delay.
   *
   * s.234C charges three months for each of the first three instalments and one month for the
   * last, whatever the actual delay — it is not the "month or part of a month" of s.234B, and
   * it does not stop when the money is eventually paid. Computing it from elapsed time gives a
   * different, larger number every day that passes.
   */
  interestMonths: number
}[] = [
  { by: 'JUN', cumulativePct: 15, safeHarbourPct: 12, interestMonths: 3 },
  { by: 'SEP', cumulativePct: 45, safeHarbourPct: 36, interestMonths: 3 },
  { by: 'DEC', cumulativePct: 75, safeHarbourPct: 75, interestMonths: 3 },
  { by: 'MAR', cumulativePct: 100, safeHarbourPct: 100, interestMonths: 1 },
]

/** s.234C runs at 1% a month on the shortfall. */
export const ADVANCE_TAX_INTEREST_PCT_PER_MONTH = 1

export function advanceTaxDue(by: 'JUN' | 'SEP' | 'DEC' | 'MAR', fyStartYear: number): Date {
  switch (by) {
    case 'JUN': return utc(fyStartYear, 6, 15)
    case 'SEP': return utc(fyStartYear, 9, 15)
    case 'DEC': return utc(fyStartYear, 12, 15)
    case 'MAR': return utc(fyStartYear + 1, 3, 15)
  }
}

/**
 * 🔴 The LUT must be filed BEFORE the financial year it covers.
 *
 * It is not a deadline that can be met late and tidied up afterwards: an export invoice
 * raised zero-rated without a current LUT is simply not zero-rated, and the IGST becomes
 * payable. So the date that matters is 31 March — the day before the year it covers begins.
 */
export function lutRenewalDue(fyStartYear: number): Date {
  return utc(fyStartYear, 3, 31)
}

/** Company ITR where a tax audit applies — 31 October following the year. */
export function itrDue(fyStartYear: number): Date {
  return utc(fyStartYear + 1, 10, 31)
}
