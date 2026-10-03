import { describe, it, expect } from 'vitest'
import { shouldChaseOverdue, dayKey } from '@/server/services/notify/schedule'

describe('🔴 how often an overdue invoice is chased', () => {
  it('does not chase before it is late', () => {
    expect(shouldChaseOverdue(0)).toBe(false)
    expect(shouldChaseOverdue(-3)).toBe(false)
  })

  it('chases on the first day, at a week and at a fortnight', () => {
    expect(shouldChaseOverdue(1)).toBe(true)
    expect(shouldChaseOverdue(7)).toBe(true)
    expect(shouldChaseOverdue(14)).toBe(true)
  })

  it('🔴 is silent in between, because daily is how notifications get turned off', () => {
    for (const d of [2, 3, 5, 8, 13, 15, 20, 29]) {
      expect(shouldChaseOverdue(d), `day ${d}`).toBe(false)
    }
  })

  it('settles into monthly after that', () => {
    expect(shouldChaseOverdue(30)).toBe(true)
    expect(shouldChaseOverdue(60)).toBe(true)
    expect(shouldChaseOverdue(90)).toBe(true)
    expect(shouldChaseOverdue(91)).toBe(false)
  })

  it('sends at most eight times in a year, not three hundred', () => {
    const count = Array.from({ length: 365 }, (_, i) => i + 1).filter(shouldChaseOverdue).length
    expect(count).toBeLessThanOrEqual(15)
    expect(count).toBeGreaterThan(3)
  })
})

describe('🔴 the day key', () => {
  it('is UTC midnight, so "already sent today" is decidable', () => {
    const k = dayKey(new Date('2026-10-03T18:45:12.345Z'))
    expect(k.toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  it('is the same for two moments on the same day', () => {
    expect(dayKey(new Date('2026-10-03T00:00:00Z')).getTime())
      .toBe(dayKey(new Date('2026-10-03T23:59:59Z')).getTime())
  })
})
