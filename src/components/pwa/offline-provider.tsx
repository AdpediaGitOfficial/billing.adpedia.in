'use client'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { drain, pendingCount, stuckItems } from '@/lib/offline/queue'

interface OfflineState {
  online: boolean
  pending: number
  /** docs/60 — refused by the server; these will not clear by waiting */
  stuck: { description: string; error: string }[]
  syncing: boolean
  refresh: () => Promise<void>
  syncNow: () => Promise<void>
}

const Ctx = createContext<OfflineState>({
  online: true, pending: 0, stuck: [], syncing: false,
  refresh: async () => {}, syncNow: async () => {},
})

export const useOffline = () => useContext(Ctx)

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState(0)
  const [stuck, setStuck] = useState<{ description: string; error: string }[]>([])
  const [syncing, setSyncing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setPending(await pendingCount())
      setStuck(await stuckItems())
    } catch { /* IndexedDB blocked — treat as empty */ }
  }, [])

  const syncNow = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await drain()
    } catch { /* keep whatever is queued; it will be retried */ }
    finally {
      setSyncing(false)
      await refresh()
    }
  }, [syncing, refresh])

  useEffect(() => {
    setOnline(navigator.onLine)
    void refresh()

    const goOnline = () => { setOnline(true); void syncNow() }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* unsupported or blocked */ })
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type === 'drain-expense-queue') void syncNow()
      }
      navigator.serviceWorker.addEventListener('message', onMessage)
      return () => {
        window.removeEventListener('online', goOnline)
        window.removeEventListener('offline', goOffline)
        navigator.serviceWorker.removeEventListener('message', onMessage)
      }
    }
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
    // syncNow is stable enough for this lifecycle; re-running would re-register the worker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  return (
    <Ctx.Provider value={{ online, pending, stuck, syncing, refresh, syncNow }}>
      {children}
      <OfflineBar />
    </Ctx.Provider>
  )
}

/** A single honest line about connection state — never a spinner that hides what is wrong. */
function OfflineBar() {
  const { online, pending, stuck, syncing, syncNow } = useOffline()
  if (online && pending === 0) return null

  /**
   * 🔴 A refused item gets its own words. "2 expenses waiting to sync" is true and
   * reassuring for a queue that is merely offline, and a lie about a photo the server has
   * already rejected: waiting will not clear it, and the expense it belongs to is booked
   * with no bill behind it.
   */
  if (stuck.length > 0 && online) {
    return (
      <div role="status"
        className="fixed inset-x-0 bottom-[var(--tabs-h,64px)] z-40 mx-3 mb-2 rounded-xl px-3.5 py-2.5 text-[12.5px] shadow-lg sm:bottom-3 sm:left-auto sm:right-3 sm:mx-0 sm:max-w-sm"
        style={{ background: 'var(--critical-soft)', color: 'var(--critical)', border: '1px solid var(--rule)' }}>
        <strong>
          {stuck.length === 1 ? 'A receipt was refused' : `${stuck.length} receipts were refused`}
        </strong>
        <span className="mt-0.5 block" style={{ opacity: 0.9 }}>
          {stuck[0].description}: {stuck[0].error} The expense is filed; attach the bill from the
          expense itself.
        </span>
      </div>
    )
  }

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-[var(--tabs-h,64px)] z-40 mx-3 mb-2 flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-[12.5px] shadow-lg sm:bottom-3 sm:left-auto sm:right-3 sm:mx-0 sm:max-w-sm"
      style={{ background: online ? 'var(--surface-1)' : '#2a2738', color: online ? 'var(--text-primary)' : '#f4f3f8', border: '1px solid var(--rule)' }}
    >
      <span>
        {!online && <strong>Offline. </strong>}
        {pending > 0
          ? `${pending} expense${pending > 1 ? 's' : ''} waiting to sync`
          : 'Changes will sync when you reconnect'}
      </span>
      {online && pending > 0 && (
        <button onClick={() => void syncNow()} disabled={syncing}
          className="shrink-0 rounded-lg px-2.5 py-1 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', opacity: syncing ? 0.6 : 1 }}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  )
}
