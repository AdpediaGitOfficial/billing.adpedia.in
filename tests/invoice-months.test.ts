import { describe, it, expect } from 'vitest'
import { monthBounds, monthLabel } from '@/server/services/sales/invoice-months'

/**
 * 🔴 docs/83 §7 — the month key, which arrives from a query string.
 *
 * `?month=` is hand-edited, bookmarked and shared, so it is the untrusted half of the month
 * view. Everything downstream — the Prisma `date` range, the header, the Clear link — is built
 * from whatever this returns, so it either returns real bounds or it returns nothing.
 */
describe('🔴 a month key from the URL', () => {
  it('bounds a month as [the 1st, the next 1st)', () => {
    const b = monthBounds('2026-11')!
    expect(b.from.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(b.to.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('crosses a year end, and a leap February', () => {
    expect(monthBounds('2026-12')!.to.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(monthBounds('2028-02')!.to.toISOString()).toBe('2028-03-01T00:00:00.000Z')
  })

  /**
   * 🔴 Half-open, not inclusive. `lte` on the last day would take `2026-11-30T00:00:00Z` and
   * exclude every invoice dated later in that day; `lt` the next 1st takes the whole month
   * whatever time of day a date was stored at.
   */
  it('is half-open, so the last day of the month is inside it', () => {
    const b = monthBounds('2026-11')!
    const lastDay = new Date('2026-11-30T18:30:00.000Z')
    expect(lastDay >= b.from && lastDay < b.to).toBe(true)
    expect(new Date('2026-12-01T00:00:00.000Z') < b.to).toBe(false)
  })

  it('refuses anything that is not a real month, rather than guessing', () => {
    for (const bad of ['', '2026', '2026-13', '2026-00', '2026-1', 'x', '2026-11-04', "2026-11' OR 1=1"]) {
      expect(monthBounds(bad), bad).toBeNull()
    }
  })

  it('labels one, and leaves a key it does not understand alone', () => {
    expect(monthLabel('2026-11')).toBe('Nov 2026')
    expect(monthLabel('2027-03')).toBe('Mar 2027')
    expect(monthLabel('nonsense')).toBe('nonsense')
  })
})
