'use client'
import { useEffect, useState } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import { Card, Button, Pill } from '@/components/ui/kit'

/** VAPID keys travel as base64url; the Push API wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function NotificationSetup({ publicKey, passkeyCount }: { publicKey: string; passkeyCount: number }) {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [subscribed, setSubscribed] = useState(false)
  const [passkeys, setPasskeys] = useState(passkeyCount)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      setPermission('unsupported')
      return
    }
    setPermission(Notification.permission)
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {})
  }, [])

  async function enablePush() {
    setBusy('push'); setNote(null)
    try {
      const granted = await Notification.requestPermission()
      setPermission(granted)
      if (granted !== 'granted') {
        setNote('Notifications are blocked. Turn them back on in your browser settings for this site.')
        return
      }
      if (!publicKey) {
        setNote('Push is not configured on this server — VAPID keys are missing.')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })
      const res = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) throw new Error('Could not register this device')
      setSubscribed(true)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not enable notifications')
    } finally { setBusy(null) }
  }

  async function addPasskey() {
    setBusy('passkey'); setNote(null)
    try {
      const optRes = await fetch('/api/auth/webauthn/register')
      if (!optRes.ok) throw new Error('Could not start registration')
      const options = await optRes.json()
      const attestation = await startRegistration({ optionsJSON: options })
      const verify = await fetch('/api/auth/webauthn/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestation, label: 'This device' }),
      })
      if (!verify.ok) {
        const body = await verify.json().catch(() => ({}))
        throw new Error(body?.error ?? 'Could not save the passkey')
      }
      setPasskeys((n) => n + 1)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') { setBusy(null); return }
      setNote(e instanceof Error ? e.message : 'Could not add a passkey')
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">Notifications</p>
            <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Payment received, a bill waiting on you, GST or TDS falling due, an invoice going
              overdue. Only the event — never a figure that would sit on your lock screen.
            </p>
          </div>
          {subscribed
            ? <Pill tone="good">On</Pill>
            : permission === 'denied'
              ? <Pill tone="critical">Blocked</Pill>
              : <Pill tone="neutral">Off</Pill>}
        </div>
        {permission === 'unsupported' ? (
          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            This browser does not support push notifications.
          </p>
        ) : !subscribed && (
          <Button className="mt-3" onClick={() => void enablePush()} disabled={busy === 'push'}>
            {busy === 'push' ? 'Enabling…' : 'Enable on this device'}
          </Button>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">Unlock with biometrics</p>
            <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              After five idle minutes the screen locks. A passkey lets you reopen it with a
              fingerprint, face or device PIN instead of typing your password. It never replaces
              signing in &mdash; it only re-proves the session you already have.
            </p>
          </div>
          <Pill tone={passkeys > 0 ? 'good' : 'neutral'}>
            {passkeys > 0 ? `${passkeys} registered` : 'None'}
          </Pill>
        </div>
        <Button variant="ghost" className="mt-3" onClick={() => void addPasskey()} disabled={busy === 'passkey'}>
          {busy === 'passkey' ? 'Waiting…' : 'Add a passkey'}
        </Button>
      </Card>

      {note && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}>{note}</p>
      )}
    </div>
  )
}
