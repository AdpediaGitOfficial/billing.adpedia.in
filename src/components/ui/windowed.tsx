'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * The list window — docs/13's "virtualised lists past 50 rows", docs/68 §4.
 *
 * Renders the first `step` rows and appends the next `step` when the sentinel comes into
 * view. What it buys is the first paint: a hundred invoice cards is a hundred subtrees to lay
 * out before anything is on screen, and on a phone that is the cost, not the query. Measured
 * on a 100-row expenses list, slow 4G and a 4× CPU throttle: `domInteractive` 2.1s with every
 * row in the DOM.
 *
 * 🔴 Windowing a server-rendered list bounds the DOM, not the payload. All of the rows are
 * already in the RSC stream by the time this runs — cutting the bytes needs pagination, which
 * is why the journal takes 50 at a time server-side. The largest list in this system is 200
 * rows, so there is no row recycling: the tail accumulates as it is revealed, and
 * `content-visibility` keeps what has scrolled past out of layout and paint.
 *
 * 🔴 With JavaScript off, the tail never arrives. That is a deliberate trade for an installed
 * PWA whose offline queue is JavaScript anyway, and it is why the count is stated — a list
 * that silently stops at 50 reads as a list of 50.
 */

const STEP = 50

/** Shared by both renderings, because a `<div>` may not go inside a `<tbody>`. */
export function useWindow(total: number, step = STEP) {
  const [shown, setShown] = useState(Math.min(step, total))
  const sentinel = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (shown >= total) return
    const el = sentinel.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setShown(total); return }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(n + step, total))
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, total, step])

  return { shown, sentinel, more: shown < total }
}

/** The mobile card list. */
export function Windowed({ children, step = STEP, estimate = 64, noun = 'rows' }: {
  children: React.ReactNode[]
  step?: number
  /** Approximate row height, so an unrevealed row still reserves its space. */
  estimate?: number
  noun?: string
}) {
  const total = children.length
  const { shown, sentinel, more } = useWindow(total, step)

  return (
    <>
      {children.slice(0, shown).map((child, i) => (
        <div key={i} data-list-row
             style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${estimate}px` } as React.CSSProperties}>
          {child}
        </div>
      ))}
      {more && (
        <div ref={(n) => { sentinel.current = n }} className="px-4 py-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {shown} of {total} {noun}…
        </div>
      )}
    </>
  )
}

/**
 * The desktop table's rows.
 *
 * 🔴 It is windowed for the PHONE's sake, not the desk's. `DataTable` renders both the table
 * and the cards and hides one with CSS, so a phone showing fifty cards was also parsing and
 * holding a hundred table rows it can never see — `display: none` skips layout and paint, not
 * the DOM. On a 100-row list that was about a thousand nodes of pure waste.
 */
export function WindowedRows({ children, colSpan, step = STEP, noun = 'rows' }: {
  children: React.ReactNode[]
  colSpan: number
  step?: number
  noun?: string
}) {
  const total = children.length
  const { shown, sentinel, more } = useWindow(total, step)

  return (
    <>
      {children.slice(0, shown)}
      {more && (
        <tr ref={(n) => { sentinel.current = n }}>
          <td colSpan={colSpan} className="px-4 py-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {shown} of {total} {noun}…
          </td>
        </tr>
      )}
    </>
  )
}
