'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'

const IDLE_MS = 5 * 60_000

/**
 * Re-authenticate after five idle minutes.
 *
 * 🔴 This is a privacy screen over an already-authenticated session, NOT a security
 * boundary. It is drawn in the browser, so anything it covers has already been sent to
 * the device and a determined person can read it from the DOM. What it actually buys is
 * the realistic case: a phone left on a desk, or handed to someone to look at something
 * else. The real boundary is the session cookie and the server's role checks.
 *
 * It is stated plainly here so nobody later mistakes it for access control and skips a
 * server-side permission check because "the lock screen covers it".
 */
export function IdleLock() {
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasPasskey, setHasPasskey] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setLocked(true), IDLE_MS)
  }, [])

  useEffect(() => {
    if (locked) return
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    const onActivity = () => arm()
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    // a phone that goes to sleep is idle even without events
    const onVisible = () => { if (document.visibilityState === 'visible') arm() }
    document.addEventListener('visibilitychange', onVisible)
    arm()
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      document.removeEventListener('visibilitychange', onVisible)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [locked, arm])

  const unlock = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/auth/webauthn/authenticate')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setHasPasskey(false)
        throw new Error(body?.error ?? 'Passkey unavailable')
      }
      const options = await res.json()
      const assertion = await startAuthentication({ optionsJSON: options })
      const verify = await fetch('/api/auth/webauthn/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: assertion }),
      })
      if (!verify.ok) {
        const body = await verify.json().catch(() => ({}))
        throw new Error(body?.error ?? 'That did not match')
      }
      setLocked(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not verify')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!locked) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: 'rgba(16,14,23,0.92)', backdropFilter: 'blur(14px)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--rule)' }}>
        <p className="text-[15px] font-semibold">Locked after 5 minutes idle</p>
        <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {hasPasskey
            ? 'Unlock with your fingerprint, face or device PIN.'
            : 'No passkey is registered on this device. Sign in again to continue.'}
        </p>

        {error && (
          <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{error}</p>
        )}

        <div className="mt-4 space-y-2">
          {hasPasskey && (
            <button onClick={() => void unlock()} disabled={busy}
              className="w-full rounded-lg py-2.5 text-[14px] font-semibold"
              style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Waiting…' : 'Unlock'}
            </button>
          )}
          {/* a hard navigation on purpose, not a soft route change: signing in again should
              discard whatever this session had in memory, not carry it across */}
          <button onClick={() => { window.location.href = '/login' }}
            className="block w-full rounded-lg border py-2.5 text-center text-[14px] font-medium"
            style={{ borderColor: 'var(--rule)' }}>
            Sign in with password
          </button>
        </div>
      </div>
    </div>
  )
}
