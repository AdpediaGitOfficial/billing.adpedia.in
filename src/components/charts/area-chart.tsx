'use client'
import { useId, useRef, useState } from 'react'
import { formatBy, type ValueFormat } from './format'
import { tapTarget } from '@/components/ui/kit'

export interface SeriesPoint { label: string; values: number[] }
export interface AreaChartProps {
  points: SeriesPoint[]
  series: { name: string; color: string }[]
  format?: ValueFormat
  height?: number
  /** rendered under the plot when the viewer opens the table view */
  caption?: string
}

const PAD = { t: 12, r: 12, b: 26, l: 52 }

/**
 * Area chart for change-over-time.
 * Per the dataviz method: 2px strokes, recessive grid, a legend whenever there is
 * more than one series, a crosshair + tooltip by default, and a table view so the
 * numbers are reachable without reading pixels.
 */
export function AreaChart({ points, series, format = 'number', height = 220, caption }: AreaChartProps) {
  const formatValue = (n: number) => formatBy(format, n)
  const uid = useId().replace(/:/g, '')
  const ref = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) {
    return <div className="grid place-items-center text-[13px]" style={{ height, color: 'var(--text-muted)' }}>No data for this period</div>
  }

  const W = 720, H = height
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const max = Math.max(1, ...points.flatMap((p) => p.values))
  const niceMax = niceCeil(max)
  const x = (i: number) => PAD.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (v: number) => PAD.t + innerH - (v / niceMax) * innerH

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => niceMax * f)

  function path(si: number, close: boolean) {
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.values[si] ?? 0).toFixed(1)}`).join(' ')
    return close ? `${d} L${x(points.length - 1).toFixed(1)},${(PAD.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.t + innerH).toFixed(1)} Z` : d
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((px - PAD.l) / innerW) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }

  const labelEvery = Math.ceil(points.length / 12)

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-4">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
          <button type="button" onClick={() => setShowTable((v) => !v)}
            className={`ml-auto text-[11.5px] font-medium no-print ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>
            {showTable ? 'Hide table' : 'Table view'}
          </button>
        </div>
      )}

      <div className="relative">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img"
             aria-label={caption ?? 'Time series'}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.26" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>

          {/* recessive grid */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
              <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--axis-text)" className="tabular">
                {formatValue(t)}
              </text>
            </g>
          ))}

          {series.map((s, si) => (
            <g key={si}>
              <path d={path(si, true)} fill={`url(#${uid}-g${si})`} />
              <path d={path(si, false)} fill="none" stroke={s.color} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </g>
          ))}

          {points.map((p, i) => (
            i % labelEvery === 0 && (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--axis-text)">{p.label}</text>
            )
          ))}

          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} stroke="var(--rule-strong)" strokeWidth="1" strokeDasharray="3 3" />
              {series.map((s, si) => (
                <circle key={si} cx={x(hover)} cy={y(points[hover].values[si] ?? 0)} r="4.5"
                        fill={s.color} stroke="var(--surface-1)" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>

        {hover !== null && (
          <div className="pointer-events-none absolute z-10 rounded-lg border px-3 py-2 text-[12px] shadow-md"
               style={{
                 background: 'var(--surface-1)', borderColor: 'var(--rule)',
                 left: `${(x(hover) / W) * 100}%`, top: 4,
                 transform: `translateX(${hover > points.length / 2 ? '-110%' : '10%'})`,
               }}>
            <p className="font-semibold">{points[hover].label}</p>
            {series.map((s, si) => (
              <p key={si} className="mt-0.5 flex items-center gap-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}
                <span className="ml-auto pl-3 font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
                  {formatValue(points[hover].values[si] ?? 0)}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>

      {showTable && (
        <table className="mt-4 w-full text-[12px]">
          <thead>
            <tr>
              <th className="py-1 text-left eyebrow">Period</th>
              {series.map((s) => <th key={s.name} className="py-1 text-right eyebrow">{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-1.5">{p.label}</td>
                {series.map((_, si) => <td key={si} className="py-1.5 text-right tabular">{formatValue(p.values[si] ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function niceCeil(n: number) {
  if (n <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(n)))
  const f = n / mag
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag
}
