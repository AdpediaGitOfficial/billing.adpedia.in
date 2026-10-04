import { describe, it, expect } from 'vitest'
import { axisOf, damp, release, FIRE_PX, REST_PX, SLOP_PX } from '@/lib/swipe-gesture'

/** docs/68 §3 — the gesture's decisions, without a DOM. */

describe('which way the finger has committed', () => {
  it('claims nothing inside the slop', () => {
    expect(axisOf(5, 3)).toBe('none')
    expect(axisOf(SLOP_PX - 1, 0)).toBe('none')
  })

  it('claims horizontal once the slop is cleared', () => {
    expect(axisOf(SLOP_PX, 0)).toBe('x')
    expect(axisOf(-40, 6)).toBe('x')
  })

  /**
   * 🔴 A list is for scrolling. A gesture that steals an ambiguous movement makes the list
   * feel broken, and the cost of conceding is only a few pixels of lag at the start of a
   * real swipe.
   */
  it('gives an ambiguous movement to the scroll', () => {
    expect(axisOf(30, 30)).toBe('y')
    expect(axisOf(20, 25)).toBe('y')
  })
})

describe('how far the row follows the finger', () => {
  it('follows exactly up to the fire point', () => {
    expect(damp(40)).toBe(40)
    expect(damp(-40)).toBe(-40)
    expect(damp(FIRE_PX)).toBe(FIRE_PX)
  })

  it('resists past it, so the threshold can be felt', () => {
    expect(damp(FIRE_PX + 100)).toBeGreaterThan(FIRE_PX)
    expect(damp(FIRE_PX + 100)).toBeLessThan(FIRE_PX + 100)
  })

  it('is symmetric', () => {
    expect(damp(-200)).toBe(-damp(200))
  })
})

describe('what a release does', () => {
  const both = { right: 'a', left: 'b' }

  it('fires past the fire point', () => {
    expect(release(FIRE_PX, both)).toBe('fire')
    expect(release(-FIRE_PX - 20, both)).toBe('fire')
  })

  it('rests open between the two thresholds, so the action can be tapped instead', () => {
    expect(release(REST_PX, both)).toBe('rest')
    expect(release(FIRE_PX - 1, both)).toBe('rest')
  })

  it('snaps back below the rest point', () => {
    expect(release(REST_PX - 1, both)).toBe('reset')
    expect(release(0, both)).toBe('reset')
  })

  /** 🔴 A side with no action must not open an empty panel, however far it is pulled. */
  it('does nothing towards a side that has no action', () => {
    expect(release(200, { right: 'a' })).toBe('fire')
    expect(release(-200, { right: 'a' })).toBe('reset')
    expect(release(200, { left: 'b' })).toBe('reset')
  })
})
