import { cn } from '@/lib/utils'
import { Icon } from '@/components/shell/icon'

/* ── surfaces ─────────────────────────────────────────────────────────────── */

export function Card({ className, children, flush }: { className?: string; children: React.ReactNode; flush?: boolean }) {
  return <div className={cn('card', !flush && 'p-5', className)}>{children}</div>
}

export function CardHeader({ title, sub, action, className }: {
  title: string; sub?: string; action?: React.ReactNode; className?: string
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function PageHeader({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {sub && <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>{sub}</p>}
      </div>
      {action && <div className="flex gap-2">{action}</div>}
    </div>
  )
}

/* ── numbers ──────────────────────────────────────────────────────────────── */

export function DeltaChip({ value, suffix = 'vs last month', invert }: {
  value: number | null; suffix?: string; invert?: boolean
}) {
  if (value === null || !isFinite(value)) return null
  const up = value >= 0
  const good = invert ? !up : up
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular"
          style={{ background: good ? 'var(--good-soft)' : 'var(--critical-soft)', color: good ? 'var(--good)' : 'var(--critical)' }}>
      <Icon name={up ? 'TrendingUp' : 'TrendingDown'} size={11} strokeWidth={2.5} />
      {up ? '+' : ''}{value.toFixed(1)}%
      <span className="font-normal opacity-75">{suffix}</span>
    </span>
  )
}

export function StatCard({ label, value, delta, deltaSuffix, invertDelta, icon, foot, tone = 'default', children }: {
  label: string; value: string
  delta?: number | null; deltaSuffix?: string; invertDelta?: boolean
  icon?: string; foot?: string
  tone?: 'default' | 'accent'
  children?: React.ReactNode
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">{label}</p>
        {icon && (
          <span className="grid h-7 w-7 place-items-center rounded-lg"
                style={{ background: tone === 'accent' ? 'var(--accent)' : 'var(--accent-soft)',
                         color: tone === 'accent' ? '#fff' : 'var(--accent)' }}>
            <Icon name={icon} size={14} strokeWidth={2} />
          </span>
        )}
      </div>
      <p className="mt-2 text-[24px] font-semibold leading-none tracking-[-0.02em] tabular">{value}</p>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div>
          {delta !== undefined && <DeltaChip value={delta ?? null} suffix={deltaSuffix} invert={invertDelta} />}
          {foot && <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{foot}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function HeroStat({ label, value, delta, foot }: { label: string; value: string; delta?: number | null; foot?: string }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="mt-2 text-[38px] font-semibold leading-none tracking-[-0.025em] tabular">{value}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {delta !== undefined && <DeltaChip value={delta ?? null} />}
        {foot && <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{foot}</span>}
      </div>
    </div>
  )
}

/* ── indicators ───────────────────────────────────────────────────────────── */

export function ProgressBar({ value, max, tone = 'accent', label, right }: {
  value: number; max: number; tone?: 'accent' | 'good' | 'warn' | 'critical'; label?: string; right?: string
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const color = { accent: 'var(--accent)', good: 'var(--good)', warn: 'var(--warn)', critical: 'var(--critical)' }[tone]
  return (
    <div>
      {(label || right) && (
        <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
          <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
          <span className="font-semibold tabular">{right}</span>
        </div>
      )}
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'critical' | 'info'

export function Pill({ children, tone = 'neutral', dot }: { children: React.ReactNode; tone?: Tone; dot?: boolean }) {
  const map: Record<Tone, { bg: string; fg: string }> = {
    neutral:  { bg: 'var(--surface-3)',   fg: 'var(--text-secondary)' },
    accent:   { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)' },
    good:     { bg: 'var(--good-soft)',   fg: 'var(--good)' },
    warn:     { bg: 'var(--warn-soft)',   fg: 'var(--warn)' },
    critical: { bg: 'var(--critical-soft)', fg: 'var(--critical)' },
    info:     { bg: 'var(--info-soft)',   fg: 'var(--info)' },
  }
  const t = map[tone]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: t.bg, color: t.fg }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.fg }} />}
      {children}
    </span>
  )
}

/* ── controls ─────────────────────────────────────────────────────────────── */

export function Segmented({ options, value, onChange, name }: {
  options: { value: string; label: string }[]; value: string; onChange?: (v: string) => void; name?: string
}) {
  return (
    <div className="inline-flex rounded-full p-0.5" style={{ background: 'var(--surface-3)' }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button key={o.value} type="button" name={name} onClick={() => onChange?.(o.value)}
            className="rounded-full px-3 py-1 text-[12px] font-semibold transition-colors"
            style={{ background: active ? 'var(--surface-1)' : 'transparent',
                     color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                     boxShadow: active ? 'var(--shadow-sm)' : undefined }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Button({ children, variant = 'primary', size = 'md', icon, className, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'danger'; size?: 'sm' | 'md'; icon?: string }) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const sizes = { sm: 'px-2.5 py-1.5 text-[12.5px]', md: 'px-3.5 py-2 text-[13px]' }[size]
  const styles: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#fff' },
    soft:    { background: 'var(--accent-soft)', color: 'var(--accent-ink)' },
    ghost:   { background: 'var(--surface-1)', color: 'var(--text-secondary)', border: '1px solid var(--rule)' },
    danger:  { background: 'var(--critical)', color: '#fff' },
  }
  return (
    <button {...rest} className={cn(base, sizes, className)} style={{ ...styles[variant], ...rest.style }}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && !error && <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
      {error && <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--critical)' }}>{error}</span>}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border px-3 py-2 text-[13.5px] outline-none transition-colors focus:border-[var(--accent)]'
export const inputStyle: React.CSSProperties = { borderColor: 'var(--rule)', background: 'var(--surface-1)', color: 'var(--text-primary)' }

/* ── data ─────────────────────────────────────────────────────────────────── */

export interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right' | 'center'
  width?: string
  cell: (row: T) => React.ReactNode
  /** shown on the mobile card; omit to hide there */
  mobile?: 'primary' | 'secondary' | 'value' | 'tag' | false
}

/**
 * One definition, two renderings: a table on desktop, cards below 768px.
 * docs/13 §4 — a horizontally scrolling grid on a phone is not an option.
 */
export function DataTable<T>({ columns, rows, keyOf, empty, onRowHref }: {
  columns: Column<T>[]
  rows: T[]
  keyOf: (row: T) => string
  empty?: React.ReactNode
  onRowHref?: (row: T) => string
}) {
  if (rows.length === 0) return <>{empty}</>

  const Row = ({ row, children }: { row: T; children: React.ReactNode }) =>
    onRowHref
      ? <a href={onRowHref(row)} className="contents">{children}</a>
      : <>{children}</>

  return (
    <>
      {/* desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full">
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              {columns.map((c) => (
                <th key={c.key} style={{ width: c.width }}
                    className={cn('px-4 py-2.5 eyebrow', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left')}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={keyOf(row)} className="border-t transition-colors hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--rule)' }}>
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-3 text-[13px]', c.align === 'right' ? 'text-right tabular' : c.align === 'center' ? 'text-center' : '')}>
                    {onRowHref ? <a href={onRowHref(row)} className="block">{c.cell(row)}</a> : c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* mobile — cards, never a sideways scroll */}
      <div className="divide-y md:hidden" style={{ borderColor: 'var(--rule)' }}>
        {rows.map((row) => {
          const primary = columns.find((c) => c.mobile === 'primary')
          const secondary = columns.filter((c) => c.mobile === 'secondary')
          const value = columns.find((c) => c.mobile === 'value')
          const tag = columns.find((c) => c.mobile === 'tag')
          return (
            <Row key={keyOf(row)} row={row}>
              <div className="flex items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  {primary && <div className="truncate text-[13.5px] font-semibold">{primary.cell(row)}</div>}
                  {secondary.map((c) => (
                    <div key={c.key} className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>{c.cell(row)}</div>
                  ))}
                </div>
                <div className="shrink-0 text-right">
                  {value && <div className="text-[13.5px] font-semibold tabular">{value.cell(row)}</div>}
                  {tag && <div className="mt-1">{tag.cell(row)}</div>}
                </div>
              </div>
            </Row>
          )
        })}
      </div>
    </>
  )
}

export function Empty({ title, hint, action, icon = 'Inbox' }: {
  title: string; hint?: string; action?: React.ReactNode; icon?: string
}) {
  return (
    <div className="px-6 py-14 text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <Icon name={icon} size={19} strokeWidth={1.8} />
      </span>
      <p className="mt-3.5 text-[15px] font-semibold">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Alert({ tone = 'warn', title, children, action }: {
  tone?: 'warn' | 'critical' | 'info' | 'good'; title: string; children?: React.ReactNode; action?: React.ReactNode
}) {
  const map = {
    warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)', icon: 'AlertTriangle' },
    critical: { bg: 'var(--critical-soft)', fg: 'var(--critical)', icon: 'AlertOctagon' },
    info: { bg: 'var(--info-soft)', fg: 'var(--info)', icon: 'Info' },
    good: { bg: 'var(--good-soft)', fg: 'var(--good)', icon: 'CheckCircle2' },
  }[tone]
  return (
    <div className="flex items-start gap-3 rounded-xl px-4 py-3" style={{ background: map.bg }}>
      <Icon name={map.icon} size={16} strokeWidth={2} style={{ color: map.fg, marginTop: 1, flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: map.fg }}>{title}</p>
        {children && <div className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: map.fg, opacity: 0.9 }}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
