import { describe, it, expect } from 'vitest'
import type { Constitution } from '@prisma/client'
import { Decimal } from '@/lib/money'
import { itrPosition, AUDIT_TURNOVER_LIMIT, AUDIT_TURNOVER_LIMIT_LOW_CASH } from '@/server/services/compliance/itr'

/**
 * 🔴 docs/82 §5d — which of s.139(1)'s two dates applies.
 *
 * The calendar said *"File the company income tax return"* on **31 October** for every entity,
 * because when it was written there was one entity and it was a company. A proprietorship owes
 * 31 July under clause (c): told October, it files three months late and pays s.234A interest,
 * a s.234F fee, and loses the loss carry-forward under s.80.
 */

const d = (x: Date) => x.toISOString().slice(0, 10)
const at = (turnover: string, constitution: Constitution = 'PROPRIETORSHIP') =>
  itrPosition({ constitution, fyStartYear: 2026, fyLabel: '2026-27', turnover: new Decimal(turnover) })

describe('🔴 the two dates in s.139(1)', () => {
  it('a company files by 31 October whatever its turnover — clause (a)', () => {
    const tiny = itrPosition({ constitution: 'PRIVATE_LIMITED', fyStartYear: 2026, fyLabel: '2026-27', turnover: new Decimal('5000') })
    expect(d(tiny.dueOn)).toBe('2027-10-31')
    expect(tiny.audited).toBe(true)
    expect(tiny.form).toBe('ITR-6')
    expect(tiny.title).toContain('company')
  })

  it('🔴 a small proprietorship files by 31 JULY — clause (c)', () => {
    const p = at('1800000')
    expect(d(p.dueOn)).toBe('2027-07-31')
    expect(p.audited).toBe(false)
    expect(p.form).toBe('ITR-3')
    expect(p.title).toContain('proprietor')
    expect(p.reportDueOn).toBeNull()
  })

  it('a firm files ITR-5, on the same clause (c) date', () => {
    for (const c of ['PARTNERSHIP', 'LLP'] as const) {
      const f = at('1800000', c)
      expect(f.form).toBe('ITR-5')
      expect(f.title).toContain('firm')
      expect(d(f.dueOn)).toBe('2027-07-31')
    }
  })

  /**
   * 🔴 The uncertainty is resolved towards the EARLIER date, and that is the whole decision.
   *
   * Between ₹1 crore and ₹10 crore the audit depends on whether cash receipts and cash
   * payments were each 5% or less — a fact about every transaction in the year, including ones
   * this system never sees. Guessing "audited" shows 31 October to somebody who may owe 31
   * July, and being late is the only one of the two mistakes that costs anything.
   */
  it('🔴 past ₹1 crore it still shows 31 July, and says what would move it', () => {
    const p = at('25000000') // ₹2.5 crore
    expect(d(p.dueOn)).toBe('2027-07-31')
    expect(p.audited).toBe(false)
    expect(p.note).toMatch(/5% or less/)
    expect(p.note).toMatch(/31 October/)
    expect(p.note).toMatch(/s\.234A|late/)
  })

  it('past ₹10 crore the audit is certain, so the date is 31 October', () => {
    const p = at('120000000') // ₹12 crore
    expect(d(p.dueOn)).toBe('2027-10-31')
    expect(p.audited).toBe(true)
    expect(p.form).toBe('ITR-3')
  })

  it('and then the audit report is due a month earlier', () => {
    expect(d(at('120000000').reportDueOn!)).toBe('2027-09-30')
  })

  it('names the s.44AD(4) trap for the entity that is nowhere near a limit', () => {
    // 🔴 declaring under 8% of turnover as income needs books and an audit at ANY turnover
    expect(at('1800000').note).toMatch(/44AD\(4\)|8%/)
  })

  it('the two limits are the ones s.44AB(a) actually carries', () => {
    expect(AUDIT_TURNOVER_LIMIT.toFixed(0)).toBe('10000000')          // ₹1 crore
    expect(AUDIT_TURNOVER_LIMIT_LOW_CASH.toFixed(0)).toBe('100000000') // ₹10 crore
  })

  it('🔴 never tells an unaudited entity it has until October', () => {
    for (const t of ['0', '1', '1800000', '9999999', '25000000', '99999999']) {
      const p = at(t)
      expect(d(p.dueOn), `turnover ${t}`).toBe('2027-07-31')
      expect(p.reportDueOn, `turnover ${t}`).toBeNull()
    }
  })
})
