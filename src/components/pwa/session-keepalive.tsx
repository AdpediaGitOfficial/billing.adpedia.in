'use client'
import { useCallback, useEffect } from 'react'

/**
 * Keeps the signed-in session alive — docs/83.
 *
 * 🔴 `/api/auth/refresh` existed, with rotating tokens, reuse detection and a thirty-day
 * lifetime, and **nothing in the application ever called it**. The access cookie is set with
 * `maxAge: ACCESS_TOKEN_TTL_SECONDS`, so fifteen minutes after signing in the cookie expired,
 * the middleware saw no token and redirected to `/login`. Mid-task, with no warning, and
 * nothing in the system logged it as anything — the session simply ended. The whole refresh
 * machinery was unexercised code sitting behind a route with no caller.
 *
 * 🔴 Refreshing from every tab on a timer is how rotation turns into a lockout: cookies are
 * shared, so two tabs present the same token and the second looks like theft. Two things stop
 * that — the `ROTATION_GRACE_MS` window on the server, and the shared timestamp below, which
 * keeps one tab from repeating what another just did.
 */

const LAST_REFRESH_KEY = 'adp:last-refresh'

/** per-viewer convenience, and it has to work when storage throws or comes back empty */
function readLast(): number {
  try { return Number(window.localStorage.getItem(LAST_REFRESH_KEY) ?? 0) || 0 } catch { return 0 }
}
function writeLast(at: number) {
  try { window.localStorage.setItem(LAST_REFRESH_KEY, String(at)) } catch { /* private window */ }
}

export function SessionKeepalive({ ttlSeconds }: { ttlSeconds: number }) {
  // 🔴 half the token's life, so a refresh that fails once still has a whole attempt left
  // before the cookie it is renewing disappears
  const everyMs = Math.max(60_000, Math.floor((ttlSeconds * 1000) / 2))

  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    const since = Date.now() - readLast()
    // another tab has just done it, and its Set-Cookie is in the jar this tab shares
    if (since < everyMs * 0.75) return

    writeLast(Date.now())
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' })
      /**
       * 🔴 Only a 401 ends the session. A failed fetch is a train tunnel, and this app is a
       * PWA that is expected to be offline (docs/30) — treating that as "signed out" would
       * throw away the queued expenses it exists to protect.
       */
      if (res.status === 401) window.location.href = '/login'
    } catch { /* offline: the cookie is still good, and the next tick tries again */ }
  }, [everyMs])

  useEffect(() => {
    const id = setInterval(() => void refresh(), everyMs)
    // 🔴 and on coming back: a phone in a pocket runs no timers, so the tick that was due
    // while the screen was off never happened
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, everyMs])

  return null
}
