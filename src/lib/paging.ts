/**
 * Paging arithmetic — docs/78.
 *
 * Pure, because every off-by-one in a paginated list is in here and none of it needs a
 * database to check. `docs/68 §4` measured what this is for: windowing the DOM of a 100-row
 * list moved `domInteractive` by 13ms, and quartering what the SERVER sends cut it by 1.26
 * seconds. The lever is the take.
 */

export const PAGE_SIZE = 50

export interface Page {
  /** 1-based, clamped into range */
  page: number
  pages: number
  skip: number
  take: number
  total: number
  /** 1-based row numbers of this page, for "51–100 of 247" */
  from: number
  to: number
  hasPrevious: boolean
  hasNext: boolean
}

/**
 * 🔴 Out of range is CLAMPED, never empty.
 *
 * `?page=99` on a two-page list is a stale link, a bookmark, or somebody who deleted enough
 * rows to shorten the list. Returning nothing renders the empty state — "No invoices yet" over
 * a company with two hundred of them — which reads as data loss. The last page is the honest
 * answer to a page that no longer exists.
 *
 * A total of zero is one page, not zero pages, so "Page 1 of 0" cannot be printed.
 */
export function paginate(total: number, requested: string | number | undefined, size = PAGE_SIZE): Page {
  const n = typeof requested === 'number' ? requested : Number(requested ?? '1')
  const pages = Math.max(1, Math.ceil(total / size))
  const page = Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), pages) : 1
  const skip = (page - 1) * size

  return {
    page,
    pages,
    skip,
    take: size,
    total,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + size, total),
    hasPrevious: page > 1,
    hasNext: page < pages,
  }
}

/** The query string for a given page, preserving whatever else was already on it. */
export function pageHref(basePath: string, params: Record<string, string | undefined>, page: number): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v && k !== 'page') q.set(k, v)
  if (page > 1) q.set('page', String(page))
  const s = q.toString()
  return s ? `${basePath}?${s}` : basePath
}
