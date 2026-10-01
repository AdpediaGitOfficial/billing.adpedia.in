'use client'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { drain, pendingCount } from '@/lib/offline/queue'

interface OfflineState {
  online: boolean
  pending: number
  syncing: boolean
  refresh: () => Promise<void>
  syncNow: () => Promise<void>
}

const Ctx = createContext<OfflineState>({
  online: true, pending: 0, syncing: false,
  refresh: async () => {}, syncNow: async () => {},
})

export const useOffline = () => useContext(Ctx)

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const refresh = useCallback(async () => {
    try { setPending(await pendingCount()) } catch { /* IndexedDB blocked — treat as empty */ }
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
    <Ctx.Provider value={{ online, pending, syncing, refresh, syncNow }}>
      {children}
      <OfflineBar />
    </Ctx.Provider>
  )
}

/** A single honest line about connection state — never a spinner that hides what is wrong. */
function OfflineBar() {
  const { online, pending, syncing, syncNow } = useOffline()
  if (online && pending === 0) return null

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
