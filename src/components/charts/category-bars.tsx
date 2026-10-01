'use client'
import { useState } from 'react'
import { formatBy, type ValueFormat } from './format'

export interface CategoryRow { label: string; value: number; meta?: string }

/**
 * Ranked magnitude list.
 *
 * 🔴 ONE hue, not a colour per row. Bar length already encodes rank; painting each
 * category a different hue would be colour-by-rank, which the dataviz method
 * forbids — recolour on filter, and no meaning in the hue. The single sequential
 * hue darkens with share, and every bar is directly labelled.
 */
export function CategoryBars({ rows, format = 'inr-whole', total }: {
  rows: CategoryRow[]
  format?: ValueFormat
  total?: number
}) {
  const formatValue = (n: number) => formatBy(format, n)
  const [hover, setHover] = useState<string | null>(null)
  if (rows.length === 0) {
    return <p className="py-8 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>Nothing to show yet</p>
  }

  const sum = total ?? rows.reduce((a, r) => a + r.value, 0)
  const max = Math.max(...rows.map((r) => r.value), 1)

  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const share = sum > 0 ? r.value / sum : 0
        const width = (r.value / max) * 100
        // sequential ramp: darker = bigger share
        const tint = share > 0.4 ? 'var(--seq-700)' : share > 0.2 ? 'var(--seq-500)' : share > 0.08 ? 'var(--seq-300)' : 'var(--seq-100)'
        return (
          <li key={r.label} onMouseEnter={() => setHover(r.label)} onMouseLeave={() => setHover(null)}>
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
              <span className="shrink-0 font-semibold tabular">{formatValue(r.value)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
                <div className="h-full rounded-full transition-[width,opacity] duration-300"
                     style={{ width: `${width}%`, background: tint, opacity: hover && hover !== r.label ? 0.45 : 1 }} />
              </div>
              <span className="w-9 shrink-0 text-right text-[11px] tabular" style={{ color: 'var(--text-muted)' }}>
                {(share * 100).toFixed(0)}%
              </span>
            </div>
            {r.meta && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.meta}</p>}
          </li>
        )
      })}
    </ul>
  )
}
