'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { applyMatchAction, skipTxnAction } from '../actions'
import { Button, Pill, type Tone } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'

interface Row {
  id: string; amount: string; direction: 'DEBIT' | 'CREDIT'; valueDate: string
  narration: string; counterparty: string | null
  suggestions: { tier: number; tierName: string; confidence: number; reason: string; kind: string }[]
}

const inr = (v: string) => '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(Number(v))

function toneFor(c: number): Tone {
  return c >= 90 ? 'good' : c >= 75 ? 'accent' : c >= 50 ? 'warn' : 'neutral'
}

export function ReconcileQueue({ rows }: { rows: Row[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [learn, setLearn] = useState(true)

  const row = rows[cursor]
  if (!row) return null

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.ok) { setCursor((c) => Math.min(c, rows.length - 2)); router.refresh() }
      else setError(r.error ?? 'Something went wrong')
    })
  }

  return (
    <div>
      {/* progress */}
      <div className="flex items-center gap-3 border-b px-5 pb-3" style={{ borderColor: 'var(--rule)' }}>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
          <div className="h-full rounded-full" style={{ width: `${(cursor / rows.length) * 100}%`, background: 'var(--accent)' }} />
        </div>
        <span className="shrink-0 text-[11.5px] tabular" style={{ color: 'var(--text-muted)' }}>
          {cursor + 1} of {rows.length}
        </span>
      </div>

      {/* the line */}
      <div className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{row.valueDate}</p>
            <p className="mt-1 text-[26px] font-semibold leading-none tabular"
               style={{ color: row.direction === 'CREDIT' ? 'var(--good)' : 'var(--text-primary)' }}>
              {row.direction === 'CREDIT' ? '+' : '−'}{inr(row.amount)}
            </p>
            <p className="mt-2 break-all font-mono text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>{row.narration}</p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button onClick={() => setCursor((c) => Math.max(0, c - 1))} disabled={cursor === 0}
              className="rounded-lg border p-2 disabled:opacity-40" style={{ borderColor: 'var(--rule)' }}>
              <Icon name="ChevronLeft" size={15} />
            </button>
            <button onClick={() => setCursor((c) => Math.min(rows.length - 1, c + 1))} disabled={cursor >= rows.length - 1}
              className="rounded-lg border p-2 disabled:opacity-40" style={{ borderColor: 'var(--rule)' }}>
              <Icon name="ChevronRight" size={15} />
            </button>
          </div>
        </div>

        {/* suggestions */}
        <div className="mt-5 space-y-2.5">
          {row.suggestions.length === 0 ? (
            <div className="rounded-xl px-4 py-3.5" style={{ background: 'var(--surface-2)' }}>
              <p className="text-[13px] font-semibold">No suggestion</p>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Nothing open matches this line. It may be an advance, an invoice not yet raised, or
                a payment to someone with no bill on file.
              </p>
            </div>
          ) : row.suggestions.slice(0, 3).map((s, i) => (
            <div key={i} className="rounded-xl border p-4" style={{ borderColor: i === 0 ? 'var(--accent)' : 'var(--rule)', background: i === 0 ? 'var(--accent-soft)' : 'var(--surface-1)' }}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill dot tone={toneFor(s.confidence)}>{s.confidence}%</Pill>
                <span className="text-[12px] font-semibold">{s.tierName}</span>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {s.kind.replace('_', ' ').toLowerCase()}
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed">{s.reason}</p>
              {/* 🔴 `s.reason` is the suggestion as the person just read it, and the action
                  refuses if the queue has reordered underneath the click — docs/86. */}
              <div className="mt-3">
                <Button size="sm" variant={i === 0 ? 'primary' : 'ghost'} disabled={pending}
                  onClick={() => run(() => applyMatchAction(row.id, i, learn, s.reason))}>
                  {pending ? 'Posting…' : 'Accept and post'}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} className="h-3.5 w-3.5" />
            Remember this for similar lines
          </label>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => skipTxnAction(row.id))}>
            Skip this line
          </Button>
        </div>

        {error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{error}</p>}
      </div>
    </div>
  )
}
