import { describe, it, expect } from 'vitest'
import { Decimal } from '@/lib/money'
import { gstInterest, GST_INTEREST_PCT } from '@/server/services/tax/gst-payment'

const D = (v: string) => new Decimal(v)

describe('🔴 interest on GST paid late — s.50(1)', () => {
  it('charges nothing when paid on time', () => {
    const r = gstInterest(D('50000'), new Date('2026-10-24'), new Date('2026-10-24'))
    expect(r.interest.toString()).toBe('0')
    expect(r.days).toBe(0)
  })

  it('charges nothing when paid early', () => {
    expect(gstInterest(D('50000'), new Date('2026-10-24'), new Date('2026-10-20')).interest.toString()).toBe('0')
  })

  it('runs simple interest per day at 18% a year', () => {
    // 50,000 × 18% × 30/365 = 739.73
    const r = gstInterest(D('50000'), new Date('2026-10-24'), new Date('2026-11-23'))
    expect(r.days).toBe(30)
    expect(r.interest.toFixed(2)).toBe('739.73')
  })

  it('🔴 runs on the CASH component, not the gross liability', () => {
    // the proviso to s.50(1), and the part people get wrong. A company with substantial ITC
    // pays most of its tax by set-off; charging interest on the gross figure can easily
    // double it. The caller passes the cash portion, and the note says so out loud.
    const cashOnly = gstInterest(D('10000'), new Date('2026-10-24'), new Date('2026-11-23'))
    const asIfGross = gstInterest(D('90000'), new Date('2026-10-24'), new Date('2026-11-23'))
    expect(cashOnly.interest.lt(asIfGross.interest)).toBe(true)
    expect(cashOnly.note).toMatch(/cash component only/)
  })

  it('charges a single day', () => {
    const r = gstInterest(D('36500'), new Date('2026-10-24'), new Date('2026-10-25'))
    expect(r.days).toBe(1)
    expect(r.interest.toFixed(2)).toBe('18.00')   // 36500 × 18% / 365
  })

  it('🔴 is per DAY, unlike TDS which is per month or part of a month', () => {
    // the two regimes genuinely differ, and applying the TDS rule here would overstate a
    // one-day delay by roughly thirtyfold
    const oneDay = gstInterest(D('100000'), new Date('2026-10-24'), new Date('2026-10-25'))
    const thirtyDays = gstInterest(D('100000'), new Date('2026-10-24'), new Date('2026-11-23'))
    expect(thirtyDays.interest.div(oneDay.interest).toFixed(0)).toBe('30')
  })

  it('states the rate it used', () => {
    expect(GST_INTEREST_PCT.toString()).toBe('18')
  })

  it('treats a nil cash liability as nothing owed, however late', () => {
    const r = gstInterest(D('0'), new Date('2026-10-24'), new Date('2027-06-01'))
    expect(r.interest.toString()).toBe('0')
  })
})
