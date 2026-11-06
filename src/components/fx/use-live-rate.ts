'use client'
import { useEffect, useState } from 'react'
export { showRate, plainRate } from '@/lib/fx'

/** `exact` is false when the rate on offer is for a different date than the one asked — the latest held, not the date's own */
export interface LiveRateInfo { rate: string; asOf: string; requested: string; source: string; stale: boolean; exact: boolean }

/**
 * docs/94 — the suggested rate for a currency on a date, fetched when either changes and again
 * every five minutes while the form stays open. Null for rupees, while loading, and when the
 * source has nothing: the form then just asks for a typed rate, as it always did.
 */
export function useLiveRate(currency: string, date: string): { live: LiveRateInfo | null; loading: boolean } {
  const [live, setLive] = useState<LiveRateInfo | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!currency || currency === 'INR') { setLive(null); return }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/fx?currency=${encodeURIComponent(currency)}${date ? `&date=${encodeURIComponent(date)}` : ''}`)
        const j = res.ok ? await res.json() : null
        if (!cancelled) setLive(j && j.rate ? { rate: j.rate, asOf: j.asOf, requested: j.requested, source: j.source, stale: !!j.stale, exact: j.requested === (date || new Date().toISOString().slice(0, 10)) || (!!date && date > new Date().toISOString().slice(0, 10) && j.requested === new Date().toISOString().slice(0, 10)) } : null)
      } catch { if (!cancelled) setLive(null) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    const t = setInterval(load, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [currency, date])

  return { live, loading }
}
