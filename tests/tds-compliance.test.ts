import { describe, it, expect } from 'vitest'
import { Decimal } from '@/lib/money'
import { depositDueDate, returnDueDate, certificateDueDate, monthsOrPart, computeInterest, computeLateFee } from '@/server/services/tax/tds-challan'
import { formForSection } from '@/server/services/tax/tds-return'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const D = (v: string | number) => new Decimal(v)

describe('deposit due dates', () => {
  it('is the 7th of the following month', () => {
    expect(depositDueDate(utc(2026, 9, 30)).toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(depositDueDate(utc(2026, 9, 1)).toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(depositDueDate(utc(2026, 12, 15)).toISOString().slice(0, 10)).toBe('2027-01-07')
  })

  it('🔴 is 30 April for March deductions, not 7 April', () => {
    expect(depositDueDate(utc(2027, 3, 1)).toISOString().slice(0, 10)).toBe('2027-04-30')
    expect(depositDueDate(utc(2027, 3, 31)).toISOString().slice(0, 10)).toBe('2027-04-30')
  })
})

describe('return and certificate due dates', () => {
  it('follows the quarterly calendar', () => {
    expect(returnDueDate(2026, 1).toISOString().slice(0, 10)).toBe('2026-07-31')
    expect(returnDueDate(2026, 2).toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(returnDueDate(2026, 3).toISOString().slice(0, 10)).toBe('2027-01-31')
    expect(returnDueDate(2026, 4).toISOString().slice(0, 10)).toBe('2027-05-31')
  })

  it('gives 15 days after the return for Form 16A', () => {
    expect(certificateDueDate(2026, 2).toISOString().slice(0, 10)).toBe('2026-11-15')
  })
})

describe('months or part of a month', () => {
  it('🔴 counts one day late as a whole month', () => {
    expect(monthsOrPart(utc(2026, 10, 7), utc(2026, 10, 8))).toBe(1)
    expect(monthsOrPart(utc(2026, 10, 7), utc(2026, 11, 6))).toBe(1)
    expect(monthsOrPart(utc(2026, 10, 7), utc(2026, 11, 8))).toBe(2)
  })

  it('is zero when not late', () => {
    expect(monthsOrPart(utc(2026, 10, 7), utc(2026, 10, 7))).toBe(0)
    expect(monthsOrPart(utc(2026, 10, 7), utc(2026, 10, 1))).toBe(0)
  })
})

describe('interest under s.201(1A)', () => {
  it('charges nothing when deducted and deposited on time', () => {
    const r = computeInterest({ tdsAmount: D('10000'), deductibleOn: utc(2026, 9, 30), deductedOn: utc(2026, 9, 30), depositedOn: utc(2026, 10, 7) })
    expect(r.total.toFixed(2)).toBe('0.00')
    expect(r.explanation).toHaveLength(0)
  })

  it('charges 1.5% a month for a late deposit', () => {
    // due 7 Oct, paid 20 Nov — two months or part
    const r = computeInterest({ tdsAmount: D('10000'), deductibleOn: utc(2026, 9, 30), deductedOn: utc(2026, 9, 30), depositedOn: utc(2026, 11, 20) })
    expect(r.notDeposited.toFixed(2)).toBe('300.00')   // 10,000 × 1.5% × 2
    expect(r.explanation.join(' ')).toMatch(/1.5% a month/)
  })

  it('charges 1% a month when deduction itself was late', () => {
    const r = computeInterest({ tdsAmount: D('10000'), deductibleOn: utc(2026, 7, 15), deductedOn: utc(2026, 9, 20), depositedOn: utc(2026, 10, 7) })
    expect(r.notDeducted.toFixed(2)).toBe('300.00')    // 3 months or part at 1%
    expect(r.notDeposited.toFixed(2)).toBe('0.00')     // deposited on time once deducted
  })

  it('charges both when deduction and deposit were late', () => {
    const r = computeInterest({ tdsAmount: D('10000'), deductibleOn: utc(2026, 7, 15), deductedOn: utc(2026, 9, 20), depositedOn: utc(2026, 11, 25) })
    expect(r.notDeducted.gt(D(0))).toBe(true)
    expect(r.notDeposited.gt(D(0))).toBe(true)
    expect(r.explanation).toHaveLength(2)
  })
})

describe('late fee under s.234E', () => {
  it('is ₹200 a day from the return due date', () => {
    const r = computeLateFee({ tdsInReturn: D('100000'), dueOn: utc(2026, 10, 31), filedOn: utc(2026, 11, 10) })
    expect(r.days).toBe(10)
    expect(r.fee.toFixed(2)).toBe('2000.00')
    expect(r.capped).toBe(false)
  })

  it('🔴 is capped at the TDS in the return', () => {
    const r = computeLateFee({ tdsInReturn: D('5000'), dueOn: utc(2026, 10, 31), filedOn: utc(2027, 3, 31) })
    expect(r.days).toBe(151)
    expect(r.fee.toFixed(2)).toBe('5000.00')          // not 30,200
    expect(r.capped).toBe(true)
  })

  it('is nothing when filed on time', () => {
    expect(computeLateFee({ tdsInReturn: D('100000'), dueOn: utc(2026, 10, 31), filedOn: utc(2026, 10, 31) }).fee.toFixed(2)).toBe('0.00')
  })
})

describe('which form reports which section', () => {
  it('routes salary to 24Q, non-residents to 27Q and the rest to 26Q', () => {
    expect(formForSection('192')).toBe('24Q')
    expect(formForSection('195')).toBe('27Q')
    expect(formForSection('194J')).toBe('26Q')
    expect(formForSection('194C')).toBe('26Q')
    expect(formForSection('194H')).toBe('26Q')
  })
})
