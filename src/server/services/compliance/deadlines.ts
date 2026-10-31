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
  | 'AGM' | 'AOC4' | 'MGT7'

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

/**
 * 🔴 s.139(1) has TWO dates, and this returned only one of them.
 *
 * Clause (a) gives 31 October to a company, to any person whose accounts must be audited, and
 * to a partner of a firm whose accounts must be audited. Clause (c) gives **31 July** to
 * everybody else. The function was written when this system had one taxpayer and that taxpayer
 * was a company, so 31 October was hardcoded and the comment even said "company ITR" — and
 * then docs/82's proprietorship was told to file three months after its deadline, with s.234A
 * interest, a s.234F fee and the loss carry-forward under s.80 denied for being late.
 *
 * 🔴 Which way the uncertainty is resolved matters more than the rule. Showing 31 October to
 * somebody who owes 31 July makes them late; showing 31 July to somebody who has until
 * October makes them early. So `audited` is only ever passed true where the system KNOWS it —
 * see `itrPosition`.
 */
export function itrDue(fyStartYear: number, audited: boolean): Date {
  return audited ? utc(fyStartYear + 1, 10, 31) : utc(fyStartYear + 1, 7, 31)
}

/**
 * The tax audit report itself — Form 3CA/3CB with 3CD.
 *
 * 🔴 Due one month BEFORE the return, s.44AB's proviso: 30 September. The return date is the
 * one people remember, and the report is the one that has to be signed by somebody else first.
 */
export function taxAuditReportDue(fyStartYear: number): Date {
  return utc(fyStartYear + 1, 9, 30)
}

/* ── company law ─────────────────────────────────────────────────────────────── */

/**
 * 🔴 The last day the AGM may be held — s.96(1).
 *
 * Within six months of the financial year's end, so 30 September for a 31 March year. Two
 * further limits apply that this cannot see: a FIRST annual general meeting gets nine months
 * from the end of the first financial year, and no two AGMs may be more than fifteen months
 * apart whatever the six-month rule allows. Both are facts about the company's history rather
 * than its books, and the fifteen-month limit can make the real deadline EARLIER than this —
 * so the date is stated as the statutory outer limit and the register of past AGMs is what
 * would narrow it.
 */
export function agmDue(fyEnd: Date): Date {
  return utc(fyEnd.getUTCFullYear(), fyEnd.getUTCMonth() + 1 + 6, 30)
}

/**
 * 🔴 AOC-4 and MGT-7 run from the AGM that was HELD, not from its deadline.
 *
 * s.137(1) gives thirty days for the financial statements and s.92(4) sixty for the annual
 * return, both counted from the date of the meeting. An AGM held on 15 August makes AOC-4 due
 * on 14 September — six weeks before the 30 October that anybody assuming a 30 September
 * meeting would have written down.
 *
 * Where no meeting has been held yet, the only honest answer is the LATEST the form could
 * fall due, which is thirty or sixty days after the last permitted AGM.
 */
export function aoc4Due(agmHeldOn: Date): Date {
  return endOfDay(new Date(agmHeldOn.getTime() + 30 * 86_400_000))
}

export function mgt7Due(agmHeldOn: Date): Date {
  return endOfDay(new Date(agmHeldOn.getTime() + 60 * 86_400_000))
}

function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59))
}

/**
 * 🔴 ₹100 a day, per form, with no upper limit.
 *
 * s.403 as amended in 2018 removed the cap and the earlier slab-based additional fee for these
 * two returns. A company that is a year late on AOC-4 owes ₹36,500 on that form alone, and the
 * same again on MGT-7 — which is why this is worth putting in front of somebody rather than
 * leaving as "a penalty may apply".
 */
export const ROC_LATE_FEE_PER_DAY = 100
