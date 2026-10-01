'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      router.push('/dashboard')
      router.refresh()
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Could not sign in')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh grid place-items-center px-5" style={{ background: 'var(--app-bg)' }}>
      <div className="w-full max-w-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/adpedia-logo.svg" alt="adpedia" className="h-6 w-auto mx-auto" />
        <p className="mt-2 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>Finance &amp; Accounts</p>

        <form onSubmit={submit} className="mt-7 rounded-xl border p-6"
              style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }}>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)' }}>
            Email
          </label>
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-md border px-3 py-2.5 text-[14px] outline-none focus:border-brand-500"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }} />

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)' }}>
            Password
          </label>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded-md border px-3 py-2.5 text-[14px] outline-none focus:border-brand-500"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }} />

          {error && (
            <p className="mt-4 rounded-md px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>
              {error}
            </p>
          )}

          <button type="submit" disabled={busy}
            className="mt-5 w-full rounded-lg py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--accent)' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
