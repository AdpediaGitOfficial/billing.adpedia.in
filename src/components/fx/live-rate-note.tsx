'use client'
import type { LiveRateInfo } from './use-live-rate'
import { showRate } from '@/lib/fx'

/**
 * docs/94 — says where the suggested rate came from, and that it is a suggestion. The booked
 * rate is whatever is in the field when the document is saved, and it stays.
 */
export function LiveRateNote({ currency, live, loading, current, onUse }: {
  currency: string; live: LiveRateInfo | null; loading: boolean
  /** what is in the field now */
  current: string
  onUse: (rate: string) => void
}) {
  if (loading && !live) return <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Looking up the {currency} rate…</p>
  if (!live) return <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>No live rate is available for {currency} — type the rate.</p>
  if (!live.exact) {
    return (
      <p className="mt-1 text-[11.5px]" style={{ color: 'var(--warn)' }}>
        No rate is available for that date — the latest held is ₹{showRate(live.rate)} per {currency} from {live.asOf} ({live.source}). Type the rate you want to book at.
      </p>
    )
  }
  const differs = current.trim() !== '' && Number(current) !== Number(live.rate)
  return (
    <p className="mt-1 text-[11.5px]" style={{ color: live.stale ? 'var(--warn)' : 'var(--text-muted)' }}>
      {live.stale ? 'Last known' : 'Live'} rate ₹{showRate(live.rate)} per {currency} · {live.source}, {live.asOf}
      {live.stale && ' · the source could not be reached'}
      {differs && (
        <> · <button type="button" onClick={() => onUse(live.rate)} className="font-semibold underline" style={{ color: 'var(--accent)' }}>use it</button></>
      )}
    </p>
  )
}
