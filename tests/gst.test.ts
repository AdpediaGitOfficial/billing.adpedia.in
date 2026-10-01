import { describe, it, expect } from 'vitest'
import { periodFor, periodsInFy, gstQuarterOf, daysUntil } from '@/server/services/tax/periods'
import { decodeArn } from '@/server/services/invoicing/lut'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

describe('GST periods', () => {
  it('quarters follow the financial year, not the calendar', () => {
    expect(gstQuarterOf(utc(2026, 4, 1)).q).toBe(1)    // Apr
    expect(gstQuarterOf(utc(2026, 9, 30)).q).toBe(2)   // Sep
    expect(gstQuarterOf(utc(2026, 12, 1)).q).toBe(3)   // Dec
    expect(gstQuarterOf(utc(2027, 2, 1)).q).toBe(4)    // Feb
  })

  it('builds a monthly period with the right due dates', () => {
    const p = periodFor(utc(2026, 9, 15), 'MONTHLY')
    expect(p.label).toBe('2026-09')
    expect(p.from.toISOString().slice(0, 10)).toBe('2026-09-01')
    expect(p.to.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(p.gstr1DueOn.toISOString().slice(0, 10)).toBe('2026-10-11')
    expect(p.gstr3bDueOn.toISOString().slice(0, 10)).toBe('2026-10-20')
  })

  it('builds a QRMP quarter with the later due dates', () => {
    const p = periodFor(utc(2026, 9, 30), 'QUARTERLY')
    expect(p.label).toBe('2026-Q2')
    expect(p.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(p.to.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(p.gstr1DueOn.toISOString().slice(0, 10)).toBe('2026-10-13')
    expect(p.gstr3bDueOn.toISOString().slice(0, 10)).toBe('2026-10-24')   // Kerala group
  })

  it('a financial year has 12 monthly or 4 quarterly periods', () => {
    const from = utc(2026, 4, 1), to = utc(2027, 3, 31)
    expect(periodsInFy(from, to, 'MONTHLY')).toHaveLength(12)
    const q = periodsInFy(from, to, 'QUARTERLY')
    expect(q).toHaveLength(4)
    expect(q.map((p) => p.label)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2027-Q4'])
  })

  it('counts days to a due date', () => {
    expect(daysUntil(utc(2026, 10, 24), utc(2026, 10, 1))).toBe(23)
    expect(daysUntil(utc(2026, 10, 1), utc(2026, 10, 24))).toBe(-23)
  })
})

describe('LUT ARN decoding', () => {
  it('decodes the two real Adpedia ARNs', () => {
    const a = decodeArn('AD320324005917B')
    expect(a).toMatchObject({ ok: true, stateCode: '32', month: 3, year: 2024, fyLabel: '2024-25' })
    const b = decodeArn('AD320325043063O')
    expect(b).toMatchObject({ ok: true, stateCode: '32', month: 3, year: 2025, fyLabel: '2025-26' })
  })

  it('rejects anything that is not an ARN', () => {
    expect(decodeArn('not-an-arn')).toMatchObject({ ok: false })
    expect(decodeArn('AD321325043063O')).toMatchObject({ ok: false })   // month 13
  })

  it('is case-insensitive and tolerates padding', () => {
    expect(decodeArn('  ad320325043063o  ')).toMatchObject({ ok: true, fyLabel: '2025-26' })
  })
})
