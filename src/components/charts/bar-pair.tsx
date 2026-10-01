'use client'
import { useState } from 'react'
import { formatBy, type ValueFormat } from './format'

export interface BarGroup { label: string; a: number; b: number }

/**
 * Two measures side by side across periods — income vs expense.
 * 4px rounded tops anchored to the baseline, a 2px gap between the pair, and a
 * per-group hover tooltip. One y-axis only; never a second scale.
 */
export function BarPair({ groups, series, format = 'inr-compact', height = 200 }: {
  groups: BarGroup[]
  series: [{ name: string; color: string }, { name: string; color: string }]
  format?: ValueFormat
  height?: number
}) {
  const formatValue = (n: number) => formatBy(format, n)
  const [hover, setHover] = useState<number | null>(null)
  if (groups.length === 0) {
    return <div className="grid place-items-center text-[13px]" style={{ height, color: 'var(--text-muted)' }}>No data for this period</div>
  }

  const W = 720, H = height, PAD = { t: 10, r: 8, b: 24, l: 52 }
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b
  const max = niceCeil(Math.max(1, ...groups.flatMap((g) => [g.a, g.b])))
  const slot = innerW / groups.length
  const barW = Math.min(14, (slot - 8) / 2)
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH
  const ticks = [0, 0.5, 1].map((f) => max * f)

  return (
    <div>
      <div className="mb-3 flex items-center gap-4">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}
          </span>
        ))}
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" aria-label="Income versus expense by period">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
              <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--axis-text)" className="tabular">{formatValue(t)}</text>
            </g>
          ))}

          {groups.map((g, i) => {
            const cx = PAD.l + slot * i + slot / 2
            const dim = hover !== null && hover !== i
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.4 : 1}>
                <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={innerH} fill="transparent" />
                <rect x={cx - barW - 1} y={y(g.a)} width={barW} height={Math.max(0, PAD.t + innerH - y(g.a))} rx="4" fill={series[0].color} />
                <rect x={cx + 1} y={y(g.b)} width={barW} height={Math.max(0, PAD.t + innerH - y(g.b))} rx="4" fill={series[1].color} />
                <text x={cx} y={H - 7} textAnchor="middle" fontSize="10.5" fill="var(--axis-text)">{g.label}</text>
              </g>
            )
          })}
        </svg>

        {hover !== null && (
          <div className="pointer-events-none absolute z-10 rounded-lg border px-3 py-2 text-[12px] shadow-md"
               style={{
                 background: 'var(--surface-1)', borderColor: 'var(--rule)', top: 4,
                 left: `${((PAD.l + slot * hover + slot / 2) / W) * 100}%`,
                 transform: `translateX(${hover > groups.length / 2 ? '-110%' : '10%'})`,
               }}>
            <p className="font-semibold">{groups[hover].label}</p>
            {([['a', series[0]], ['b', series[1]]] as const).map(([k, s]) => (
              <p key={k} className="mt-0.5 flex items-center gap-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}
                <span className="ml-auto pl-3 font-semibold tabular" style={{ color: 'var(--text-primary)' }}>{formatValue(groups[hover][k])}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function niceCeil(n: number) {
  if (n <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(n)))
  const f = n / mag
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag
}
