/** Tiny trend indicator for a stat tile. No axes, no tooltip — the tile carries the number. */
export function Sparkline({ values, color = 'var(--series-1)', width = 72, height = 24 }: {
  values: number[]; color?: string; width?: number; height?: number
}) {
  if (values.length < 2) return null
  const max = Math.max(...values), min = Math.min(...values)
  const span = max - min || 1
  const x = (i: number) => (i / (values.length - 1)) * width
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.25" fill={color} />
    </svg>
  )
}
