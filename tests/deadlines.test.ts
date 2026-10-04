import { describe, it, expect } from 'vitest'
import {
  tdsDepositDue, tdsReturnDue, form16aDue, form16Due,
  gstr1Due, gstr3bDue, pmt06Due, gstr9Due,
  professionTaxDue, advanceTaxDue, ADVANCE_TAX_SCHEDULE, ADVANCE_TAX_INTEREST_PCT_PER_MONTH,
  lutRenewalDue, itrDue, agmDue, aoc4Due, mgt7Due, ROC_LATE_FEE_PER_DAY,
} from '@/server/services/compliance/deadlines'

const d = (x: Date) => x.toISOString().slice(0, 10)

describe('🔴 TDS deposit', () => {
  it('is the 7th of the following month', () => {
    expect(d(tdsDepositDue(9, 2026))).toBe('2026-10-07')
    expect(d(tdsDepositDue(1, 2027))).toBe('2027-02-07')
  })

  it('🔴 is 30 April for March, not 7 April', () => {
    // the year has ended, so the extra time is allowed. Applying the 7th makes every March
    // deposit look three weeks late and triggers a false interest calculation.
    expect(d(tdsDepositDue(3, 2027))).toBe('2027-04-30')
  })

  it('rolls the year over in December', () => {
    expect(d(tdsDepositDue(12, 2026))).toBe('2027-01-07')
  })
})

describe('🔴 TDS return', () => {
  it('is the last day of the month after the quarter', () => {
    expect(d(tdsReturnDue(1, 2026))).toBe('2026-07-31')
    expect(d(tdsReturnDue(2, 2026))).toBe('2026-10-31')
    expect(d(tdsReturnDue(3, 2026))).toBe('2027-01-31')
  })

  it('🔴 is 31 May for Q4, not 30 April', () => {
    expect(d(tdsReturnDue(4, 2026))).toBe('2027-05-31')
  })

  it('drags Form 16A 15 days behind it', () => {
    expect(d(form16aDue(1, 2026))).toBe('2026-08-15')
    expect(d(form16aDue(4, 2026))).toBe('2027-06-15')
  })

  it('puts Form 16 on 15 June', () => {
    expect(d(form16Due(2026))).toBe('2027-06-15')
  })
})

describe('GST returns', () => {
  it('files GSTR-1 on the 11th monthly and the 13th quarterly', () => {
    expect(d(gstr1Due(new Date('2026-09-30'), false))).toBe('2026-10-11')
    expect(d(gstr1Due(new Date('2026-09-30'), true))).toBe('2026-10-13')
  })

  it('files GSTR-3B on the 20th monthly', () => {
    expect(d(gstr3bDue(new Date('2026-09-30'), false, '32'))).toBe('2026-10-20')
  })

  it('🔴 gives Kerala the 24th under QRMP, not the 22nd', () => {
    // the QRMP 3B date is split by state group; Kerala (32) is in the later one
    expect(d(gstr3bDue(new Date('2026-09-30'), true, '32'))).toBe('2026-10-24')
    expect(d(gstr3bDue(new Date('2026-09-30'), true, '07'))).toBe('2026-10-22')   // Delhi
  })

  it('pays PMT-06 by the 25th', () => {
    expect(d(pmt06Due(7, 2026))).toBe('2026-08-25')
  })

  it('files the annual return by 31 December', () => {
    expect(d(gstr9Due(2026))).toBe('2027-12-31')
  })
})

describe('🔴 advance tax', () => {
  it('runs 15 Jun / 15 Sep / 15 Dec / 15 Mar', () => {
    expect(d(advanceTaxDue('JUN', 2026))).toBe('2026-06-15')
    expect(d(advanceTaxDue('SEP', 2026))).toBe('2026-09-15')
    expect(d(advanceTaxDue('DEC', 2026))).toBe('2026-12-15')
    expect(d(advanceTaxDue('MAR', 2026))).toBe('2027-03-15')
  })

  it('🔴 states the percentages as CUMULATIVE, not per instalment', () => {
    // by 15 September the total paid must reach 45% of the year's liability — not 45% on top
    // of June's 15%. Reading them as separate instalments under-pays every quarter and
    // accrues interest under s.234C.
    expect(ADVANCE_TAX_SCHEDULE.map((s) => s.cumulativePct)).toEqual([15, 45, 75, 100])
    expect(ADVANCE_TAX_SCHEDULE.at(-1)!.cumulativePct).toBe(100)
  })
})

describe('other obligations', () => {
  it('deducts Kerala profession tax by 31 Aug and 28 Feb', () => {
    expect(d(professionTaxDue('H1', 2026))).toBe('2026-08-31')
    expect(d(professionTaxDue('H2', 2026))).toBe('2027-02-28')
  })

  it('🔴 puts the LUT BEFORE the year it covers', () => {
    // not a deadline that can be met late: an export raised zero-rated without a current LUT
    // is simply not zero-rated, and the IGST becomes payable
    expect(d(lutRenewalDue(2026))).toBe('2026-03-31')
  })

  it('files the company ITR by 31 October', () => {
    expect(d(itrDue(2026))).toBe('2027-10-31')
  })
})

/**
 * 🔴 docs/71 — the s.234C safe harbour is not a rounding of the instalment percentage.
 *
 * The provisos to s.234C(1) forgive the interest on a near miss for the first two instalments
 * only: 12% by 15 June and 36% by 15 September against required cumulatives of 15% and 45%.
 * A system that charges interest from 15% produces a plausible, legal-looking figure that is
 * simply wrong — and nobody re-checks a tax computation that looks reasonable.
 */
describe('🔴 the s.234C provisos', () => {
  it('forgives a near miss on the first two instalments only', () => {
    const by = Object.fromEntries(ADVANCE_TAX_SCHEDULE.map((s) => [s.by, s]))
    expect(by.JUN.safeHarbourPct).toBe(12)
    expect(by.SEP.safeHarbourPct).toBe(36)
    // and NOT on the third and fourth, where the harbour is the requirement itself
    expect(by.DEC.safeHarbourPct).toBe(by.DEC.cumulativePct)
    expect(by.MAR.safeHarbourPct).toBe(by.MAR.cumulativePct)
  })

  /**
   * 🔴 Three months for the first three instalments, one for the last — fixed by the statute,
   * not counted from the delay. It is not s.234B's "month or part of a month", and it does not
   * stop when the money is eventually paid; computing it from elapsed time gives a different,
   * larger number every day.
   */
  it('charges a fixed number of months, not the delay', () => {
    expect(ADVANCE_TAX_SCHEDULE.map((s) => s.interestMonths)).toEqual([3, 3, 3, 1])
  })

  it('runs at 1% a month', () => {
    expect(ADVANCE_TAX_INTEREST_PCT_PER_MONTH).toBe(1)
  })
})

/** docs/72 — the ROC forms, which key off the meeting rather than its deadline. */
describe('🔴 company law', () => {
  it('puts the AGM six months after the year end', () => {
    expect(d(agmDue(new Date('2027-03-31T23:59:59Z')))).toBe('2027-09-30')
  })

  /**
   * 🔴 Thirty and sixty days from the meeting that was HELD.
   *
   * An AGM on 15 August makes AOC-4 due on 14 September — six weeks before the 30 October
   * anybody assuming a 30 September meeting would have written down. Keying the forms off the
   * AGM's deadline instead of its date is a mistake that only shows up as a late fee.
   */
  it('runs AOC-4 and MGT-7 from the date of the meeting', () => {
    const held = new Date('2027-08-15T00:00:00Z')
    expect(d(aoc4Due(held))).toBe('2027-09-14')
    expect(d(mgt7Due(held))).toBe('2027-10-14')
  })

  it('and therefore gives later dates for a meeting held at the deadline', () => {
    const held = new Date('2027-09-30T00:00:00Z')
    expect(d(aoc4Due(held))).toBe('2027-10-30')
    expect(d(mgt7Due(held))).toBe('2027-11-29')
  })

  /** ₹100 a day per form, uncapped since the 2018 amendment to s.403. */
  it('charges a hundred rupees a day, per form', () => {
    expect(ROC_LATE_FEE_PER_DAY).toBe(100)
  })
})
