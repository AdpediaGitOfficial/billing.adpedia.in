import { describe, it, expect } from 'vitest'
import { fyLabelFor, fyBounds, fyQuarter, tdsDepositDueDate } from '@/lib/fy'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

describe('financial year', () => {
  it('runs April to March', () => {
    expect(fyLabelFor(utc(2026, 4, 1))).toBe('2026-27')
    expect(fyLabelFor(utc(2027, 3, 31))).toBe('2026-27')
    expect(fyLabelFor(utc(2026, 3, 31))).toBe('2025-26')
    expect(fyLabelFor(utc(2026, 9, 30))).toBe('2026-27')
  })

  it('places the real invoice dates in the right years', () => {
    expect(fyLabelFor(utc(2026, 3, 21))).toBe('2025-26')   // invoice 13
    expect(fyLabelFor(utc(2026, 9, 16))).toBe('2026-27')   // invoice 25
  })

  it('bounds the year correctly', () => {
    const b = fyBounds('2026-27')
    expect(b.startsOn.toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(b.endsOn.toISOString().slice(0, 10)).toBe('2027-03-31')
  })
})

describe('TDS quarters', () => {
  it('Q1 Apr-Jun through Q4 Jan-Mar', () => {
    expect(fyQuarter(utc(2026, 5, 15))).toBe(1)
    expect(fyQuarter(utc(2026, 9, 30))).toBe(2)
    expect(fyQuarter(utc(2026, 12, 1))).toBe(3)
    expect(fyQuarter(utc(2027, 2, 1))).toBe(4)
  })
})

describe('TDS deposit due dates', () => {
  it('is the 7th of the following month', () => {
    expect(tdsDepositDueDate(utc(2026, 9, 30)).toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(tdsDepositDueDate(utc(2026, 12, 15)).toISOString().slice(0, 10)).toBe('2027-01-07')
  })

  it('is 30 April for March deductions', () => {
    expect(tdsDepositDueDate(utc(2027, 3, 10)).toISOString().slice(0, 10)).toBe('2027-04-30')
  })
})
