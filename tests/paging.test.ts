import { describe, it, expect } from 'vitest'
import { paginate, pageHref, PAGE_SIZE } from '@/lib/paging'

/** docs/78 — every off-by-one in a paginated list lives in `paginate`. */

describe('paginate', () => {
  it('counts pages, and numbers the rows on this one', () => {
    const p = paginate(247, 2)
    expect(p.pages).toBe(Math.ceil(247 / PAGE_SIZE))
    expect(p.skip).toBe(50)
    expect(p.from).toBe(51)
    expect(p.to).toBe(100)
    expect(p.hasPrevious).toBe(true)
    expect(p.hasNext).toBe(true)
  })

  it('stops the last page at the last row', () => {
    const p = paginate(247, 5)
    expect(p.from).toBe(201)
    expect(p.to).toBe(247)
    expect(p.hasNext).toBe(false)
  })

  /**
   * 🔴 Clamped, never empty. A stale link or a bookmark to `?page=99` would otherwise render
   * the empty state — "No invoices yet" over a company with two hundred of them — which reads
   * as data loss rather than as a page that no longer exists.
   */
  it('clamps a page past the end to the last one', () => {
    const p = paginate(120, 99)
    expect(p.page).toBe(3)
    expect(p.to).toBe(120)
    expect(p.hasNext).toBe(false)
  })

  it('clamps nonsense to the first page', () => {
    for (const bad of ['0', '-4', 'abc', '', undefined, 'NaN']) {
      expect(paginate(120, bad).page).toBe(1)
    }
    expect(paginate(120, 1.9).page).toBe(1)
  })

  /** 🔴 An empty list is ONE page, so "Page 1 of 0" cannot be printed. */
  it('treats nothing as a single empty page', () => {
    const p = paginate(0, 1)
    expect(p.pages).toBe(1)
    expect(p.page).toBe(1)
    expect(p.from).toBe(0)
    expect(p.to).toBe(0)
    expect(p.hasPrevious).toBe(false)
    expect(p.hasNext).toBe(false)
  })

  it('fits an exact multiple without an empty trailing page', () => {
    expect(paginate(100, 1).pages).toBe(2)
    expect(paginate(100, 2).to).toBe(100)
    expect(paginate(100, 2).hasNext).toBe(false)
  })
})

describe('pageHref', () => {
  it('keeps the other parameters, and omits page=1', () => {
    expect(pageHref('/invoices', { fy: 'abc', page: '3' }, 1)).toBe('/invoices?fy=abc')
    expect(pageHref('/invoices', { fy: 'abc' }, 2)).toBe('/invoices?fy=abc&page=2')
    expect(pageHref('/invoices', {}, 1)).toBe('/invoices')
  })

  it('drops empty parameters rather than printing them', () => {
    expect(pageHref('/bills', { fy: undefined, side: '' }, 2)).toBe('/bills?page=2')
  })
})
