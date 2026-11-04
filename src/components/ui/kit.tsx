import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/shell/icon'
import type { IconName } from '@/components/shell/icons'
import { SwipeRow, type SwipeSpec } from './swipe'
import { Windowed, WindowedRows } from './windowed'

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

/**
 * 🔴 `back` is for a page the NAV cannot return you from.
 *
 * A page in the sidebar needs no back link — the rail is its navigation. A page below one does:
 * `/customers/[id]` is reached by clicking a row, and before this it had no way out at all
 * except the browser's own button, which a PWA opened from the home screen does not show. On a
 * phone, with the rail collapsed to tabs, an edit screen was a dead end.
 *
 * The href is explicit rather than derived from the pathname, because the parent is not always
 * the path minus a segment: `/projects/[id]/edit` has no `/projects/[id]` to return to.
 */
export function PageHeader({ title, sub, action, back }: {
  title: string
  sub?: string
  action?: React.ReactNode
  back?: { href: string; label: string }
}) {
  return (
    <div className="mb-6">
      {back && (
        /* 🔴 docs/83 §4 — the way back out of every page, and 19px of it on a phone */
        <Link href={back.href}
          className={`mb-2 gap-1.5 text-[12.5px] transition-colors hover:underline ${tapTarget}`}
          style={{ color: 'var(--text-secondary)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
          {sub && <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>{sub}</p>}
        </div>
        {/* 🔴 docs/83 §5 — `flex` with no wrap, which on a phone put the page's own actions
            off the right-hand edge. The invoice has six of them; at 375px the last two sat
            outside the viewport behind a horizontal scroll nothing suggested was there, and
            `Amend` — the only way to correct a sent invoice — was the one furthest out. */}
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
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

/**
 * How much room one stat value needs, as a multiple of its own font size — docs/83 §5.3.
 *
 * `.stat-value` in globals.css divides the card's width by this to pick a size below `sm`,
 * where two cards to a row leaves 134px at 375px and 106px at 320px. 0.58em is the widest
 * average advance this face gives a money figure or a rule 46 number, measured in the page.
 *
 * Fixed tiers were tried first and cannot work — the room is a function of the viewport, so
 * a tier that fits at 375px spills at 320px.
 */
export function statChars(value: string): number {
  return Math.max(4, Number((value.length * 0.58).toFixed(2)))
}

export function StatCard({ label, value, delta, deltaSuffix, invertDelta, icon, foot, tone = 'default', children }: {
  label: string; value: string
  delta?: number | null; deltaSuffix?: string; invertDelta?: boolean
  icon?: IconName; foot?: string
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
      <p className="stat-value mt-2 font-semibold leading-none tracking-[-0.02em] tabular"
        style={{ '--stat-chars': statChars(value) } as React.CSSProperties}>{value}</p>
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
            className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${tapMin}`}
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
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'danger'; size?: 'sm' | 'md'; icon?: IconName }) {
  const base = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tapMin}`
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

/**
 * 🔴 docs/83 §4 — the hit box, on a phone, for anything you press.
 *
 * `+ Add line` on the invoice form was 20px tall: a 13px label with no padding at all, and the
 * control you press once per line item. `back`, `remove`, `It matches` and `Withdraw` were
 * 17px, and two of those change a record. Apple's minimum is 44px and Android's is 48; none of
 * these were half of it. The `md:` reset keeps the dense desktop layout these were drawn for.
 *
 * 🔴 §5 — and `Button` itself was 38px, `size="sm"` about 31px.
 *
 * §4 fixed the controls that were plainly broken and left `Button` alone, on the grounds that
 * 38px is close and changing it moves every button in the app. That was the wrong line to
 * draw: `Cancel invoice`, `Reverse`, `Remove` and `Save` are all this component, 38px is still
 * under the minimum, and "close enough" is not a thing a thumb does. It moves every button on
 * a phone and no button from `md` up, which is the whole point of having one component.
 *
 * The height lives here ONCE and `tapTarget`, `Button`, `Segmented` and `inputClass` all read
 * it, so there is no second copy of the number to drift. A text field was 42px — two short of
 * the rule declared immediately below it, which is not a defect anybody would report and is
 * also not a reason to leave it.
 */
export const tapMin = 'min-h-[44px] md:min-h-0'
export const tapTarget = `inline-flex ${tapMin} items-center`

/**
 * 🔴 docs/83 §4 — 16px on a phone, and the design's 13.5px from `md` up.
 *
 * Mobile Safari zooms the page in whenever a focused form control is under 16px, and the
 * viewport is `initialScale: 1` with no `maximumScale` (deliberately — pinch-zoom is an
 * accessibility right). So every field in the app threw the layout up a notch on focus and
 * left the person to pinch back out, on each field, on the device docs/30 was written for.
 * Nothing reports this: the form works, it just fights.
 */
export const inputClass =
  `w-full rounded-lg border px-3 py-2 text-[16px] outline-none transition-colors focus:border-[var(--accent)] md:text-[13.5px] ${tapMin}`

/**
 * 🔴 docs/83 §5 — stat cards two to a row on a phone, not one.
 *
 * Every stat row in the app was `sm:grid-cols-N`, and `sm` is 640px — so at 375px all of them
 * collapsed to a single column. On `/invoices` that is four full-width cards, a whole screen
 * of summary, before the first invoice; `/bills`, `/notes`, `/chases`, both TDS screens and
 * the GST screen were the same. The numbers are worth having and they are not worth a screen,
 * and a stat card at half a phone's width still reads — it is a label and one figure.
 *
 * The odd card out goes full width rather than sitting half-empty beside nothing, and only
 * below `sm`, where the 2-up rule is what created the orphan.
 *
 * Call sites keep their own `sm:`/`lg:` columns: this sets the phone, not the desktop.
 */
export const statGrid =
  'grid grid-cols-2 gap-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 sm:gap-4'

export const inputStyle: React.CSSProperties = { borderColor: 'var(--rule)', background: 'var(--surface-1)', color: 'var(--text-primary)' }

/* ── data ─────────────────────────────────────────────────────────────────── */

export interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right' | 'center'
  width?: string
  cell: (row: T) => React.ReactNode
  /**
   * Where this column goes on the mobile card; omit to hide it there.
   *
   * 🔴 `false` on a column holding a CONTROL makes that control unreachable on a phone, and
   * `'action'` exists because two of them were (docs/68 §5): the only way to reverse an
   * expense or a receipt was a button in a desktop-only table column, and the receipt had no
   * detail page to fall back to. `tests/mobile-reachable.test.ts` is the guard.
   */
  mobile?: 'primary' | 'secondary' | 'value' | 'tag' | 'action' | false
}

/**
 * One definition, two renderings: a table on desktop, cards below 768px.
 * docs/13 §4 — a horizontally scrolling grid on a phone is not an option.
 *
 * `swipe` is evaluated here, on the server, once per row: the result is a plain object (a
 * link, or a bound server action) which is what lets a server-rendered list hand a client
 * gesture something to do. docs/68 §3.
 */
export function DataTable<T>({ columns, rows, keyOf, empty, onRowHref, swipe, noun = 'rows' }: {
  columns: Column<T>[]
  rows: T[]
  keyOf: (row: T) => string
  empty?: React.ReactNode
  onRowHref?: (row: T) => string
  /** Per-row swipe actions on the mobile card. Return nothing for a row that has none. */
  swipe?: (row: T) => SwipeSpec | undefined
  /** What a row is, for the "50 of 100 …" line under a windowed list. */
  noun?: string
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
            <WindowedRows colSpan={columns.length} noun={noun}>
              {rows.map((row) => (
                <tr key={keyOf(row)} className="border-t transition-colors hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--rule)' }}>
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3 text-[13px]', c.align === 'right' ? 'text-right tabular' : c.align === 'center' ? 'text-center' : '')}>
                      {/* 🔴 docs/83 §6 — an action column is NOT wrapped in the row link.
                          The mobile card has kept its controls outside the row anchor since
                          docs/68 §5; the desktop table wrapped every cell, so a control in
                          one was inside a link to the row. For a button that means pressing
                          Cancel navigates to the record instead of cancelling it — the exact
                          trap the comment below the card describes, still live up here. For
                          a LINK it is also invalid HTML: an `<a>` inside an `<a>` is a parse
                          error the browser repairs by unnesting, so React's hydration finds
                          a different tree than it rendered and throws. The invoice list's
                          Download link is what surfaced it. */}
                      {onRowHref && c.mobile !== 'action'
                        ? <a href={onRowHref(row)} className="block">{c.cell(row)}</a>
                        : c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </WindowedRows>
          </tbody>
        </table>
      </div>

      {/* mobile — cards, never a sideways scroll */}
      <div className="md:hidden">
        <SwipeLegend specs={swipe ? rows.map(swipe) : []} />
        <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
          <Windowed noun={noun}>
            {rows.map((row) => {
              const primary = columns.find((c) => c.mobile === 'primary')
              const secondary = columns.filter((c) => c.mobile === 'secondary')
              const value = columns.find((c) => c.mobile === 'value')
              const tag = columns.find((c) => c.mobile === 'tag')
              const actions = columns.filter((c) => c.mobile === 'action')
              /* 🔴 the controls sit OUTSIDE the row-wide anchor — the same trap the expenses
                 table hit on desktop: wrap a cancel button in a link to the row and pressing
                 it navigates away instead of asking why. */
              const card = (
                <>
                  <Row row={row}>
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
                  {actions.length > 0 && (
                    <div className="flex flex-wrap items-center justify-end gap-3 px-4 pb-3">
                      {actions.map((c) => <div key={c.key}>{c.cell(row)}</div>)}
                    </div>
                  )}
                </>
              )
              const spec = swipe?.(row)
              return (
                <div key={keyOf(row)}>
                  {spec && (spec.right || spec.left) ? <SwipeRow spec={spec}>{card}</SwipeRow> : card}
                </div>
              )
            })}
          </Windowed>
        </div>
      </div>
    </>
  )
}

/**
 * 🔴 A gesture nobody knows about is not a feature. One line, once, above the list — not a
 * coach mark that has to be dismissed, and not a tooltip on a device with no hover.
 *
 * 🔴 Taken from every row, not the first one. The spec is decided per row, so an invoice list
 * whose newest entry happens to be a draft announced "swipe right to Send" above a screen of
 * sent invoices that do nothing of the kind. When the rows disagree the legend stops naming
 * the action and says only that there is one.
 */
function SwipeLegend({ specs }: { specs: (SwipeSpec | undefined)[] }) {
  const side = (pick: (s: SwipeSpec) => SwipeSpec['right']) => {
    const named = new Set<string>()
    for (const s of specs) { const i = s && pick(s); if (i) named.add(i.legend ?? i.label) }
    return named.size === 1 ? [...named][0] : named.size > 1 ? 'what it needs next' : null
  }
  const right = side((s) => s.right)
  const left = side((s) => s.left)
  if (!right && !left) return null
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[11px]"
       style={{ color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
      <span>Swipe a row</span>
      {right && <span className="flex items-center gap-1"><Icon name="ArrowRight" size={11} strokeWidth={2.2} />{right}</span>}
      {left && <span className="flex items-center gap-1"><Icon name="ArrowLeft" size={11} strokeWidth={2.2} />{left}</span>}
    </p>
  )
}

export function Empty({ title, hint, action, icon = 'Inbox' }: {
  title: string; hint?: string; action?: React.ReactNode; icon?: IconName
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
  const map = ({
    warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)', icon: 'AlertTriangle' },
    critical: { bg: 'var(--critical-soft)', fg: 'var(--critical)', icon: 'AlertOctagon' },
    info: { bg: 'var(--info-soft)', fg: 'var(--info)', icon: 'Info' },
    good: { bg: 'var(--good-soft)', fg: 'var(--good)', icon: 'CheckCircle2' },
  } satisfies Record<string, { bg: string; fg: string; icon: IconName }>)[tone]
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

/* ── figures on a phone ───────────────────────────────────────────────────── */

export interface Figure { label: string; value: React.ReactNode; strong?: boolean; muted?: boolean }

/**
 * A numeric table row, as a card — docs/68 §7.
 *
 * `DataTable` turns a list of RECORDS into cards: one headline, a note, a figure, a status.
 * A trial balance row is not that shape — it is an account and six columns, and squeezing it
 * into one value slot loses the thing the row is for. So the figures wrap instead, and the
 * table stays for the desk.
 *
 * 🔴 It exists because five tables were still scrolling sideways on a phone, against a rule
 * written in docs/13 §4 that says never. Nothing caught them: they are not `DataTable`
 * callers, so the card rendering that rule lives in simply never applied to them. Measuring
 * at 375px is what found them, and `scripts/perf.mts --overflow` is what keeps them found.
 */
export function FigureCard({ title, sub, href, figures }: {
  title: React.ReactNode
  sub?: React.ReactNode
  href?: string
  figures: Figure[]
}) {
  const head = (
    <div className="min-w-0">
      <div className="truncate text-[13.5px] font-semibold">{title}</div>
      {sub && <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
  return (
    <div className="px-4 py-3.5">
      {href ? <a href={href} className="block">{head}</a> : head}
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        {figures.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-2 overflow-hidden">
            {/* 🔴 The LABEL truncates; the figure never does. The first version had it the
                other way round and a trial balance read "₹7,43,40…" — a number you cannot
                read is the one thing a ledger may not print, and "Closing Dr" clipped to
                "Closing D" costs nothing. */}
            <dt className="eyebrow min-w-0 truncate">{f.label}</dt>
            <dd className={cn('shrink-0 whitespace-nowrap text-right text-[12.5px] tabular', f.strong && 'font-semibold')}
                style={f.muted ? { color: 'var(--text-muted)' } : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** The phone-only list the cards go in. The table beside it carries `hidden md:block`. */
export function FigureList({ children, noun = 'rows' }: { children: React.ReactNode[]; noun?: string }) {
  return (
    <div className="divide-y md:hidden" style={{ borderColor: 'var(--rule)' }}>
      <Windowed noun={noun} estimate={96}>{children}</Windowed>
    </div>
  )
}
