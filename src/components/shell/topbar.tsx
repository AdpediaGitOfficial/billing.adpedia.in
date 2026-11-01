'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Icon } from './icon'

export function Topbar({ name, role, fyLabel, alerts = 0, company }: {
  name: string; role: string; fyLabel?: string; alerts?: number
  /**
   * 🔴 docs/83 — WHICH BOOKS AM I IN, on a phone.
   *
   * The sidebar carries this and the sidebar is `hidden md:flex`, so on a phone the only thing
   * in the header was Adpedia's logo — hardcoded, on every entity's screens. docs/82 §3 says
   * the current entity must be impossible to mistake, because an invoice raised in the wrong
   * one is numbered from that entity's series, posted to its ledger and frozen on send. On the
   * device most likely to be used in a hurry, there was nothing to mistake it BY.
   *
   * 🔴 §4 — and the name is the whole of it. The first fix put the entity's own `logoUrl`
   * here beside the name, which at the 20px a phone header can spare rendered a wordmark as
   * an illegible smudge AND took 28px from the one thing that does identify the entity. Both
   * of these begin with "A", so the initial is decoration: the name is the identifier, and it
   * gets the width. The sidebar still shows the logo, where there is room for it to read.
   */
  company: string
}) {
  const router = useRouter()
  const [menu, setMenu] = useState(false)
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login'); router.refresh()
  }

  return (
    <header className="no-print sticky top-0 z-20 flex items-center gap-3 border-b px-4 py-2.5 md:px-6"
            style={{ borderColor: 'var(--rule)', background: 'color-mix(in srgb, var(--app-bg) 88%, transparent)', backdropFilter: 'blur(8px)' }}>
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] font-bold"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {company.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate text-[13px] font-semibold">{company}</span>
      </div>

      <div className="relative hidden max-w-sm flex-1 md:block">
        <Icon name="Search" size={14} strokeWidth={2}
              style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }} />
        <input placeholder="Search invoices, customers, vendors…"
          className="w-full rounded-lg border py-[7px] pl-8 pr-3 text-[16px] outline-none focus:border-[var(--accent)] md:text-[12.5px]"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {fyLabel && (
          <span className="hidden rounded-lg px-2.5 py-1.5 text-[12px] font-semibold sm:inline-block"
                style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)' }}>
            FY {fyLabel}
          </span>
        )}

        <button className="relative grid h-8 w-8 place-items-center rounded-lg" style={{ color: 'var(--text-secondary)' }} aria-label="Notifications">
          <Icon name="Bell" size={16} strokeWidth={1.8} />
          {alerts > 0 && (
            <span className="absolute right-1 top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full px-1 text-[9px] font-bold text-white"
                  style={{ background: 'var(--critical)' }}>{alerts}</span>
          )}
        </button>

        <div className="relative">
          <button onClick={() => setMenu((v) => !v)} className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2">
            <span className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: 'var(--accent)' }}>
              {initials}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-[12.5px] font-semibold">{name}</span>
              <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>{role.replace('_', ' ')}</span>
            </span>
            <Icon name="ChevronDown" size={13} strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
          </button>

          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1.5 w-48 rounded-xl border p-1 shadow-md"
                   style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)', boxShadow: 'var(--shadow-md)' }}>
                <button onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]"
                        style={{ color: 'var(--text-secondary)' }}>
                  <Icon name="LogOut" size={14} strokeWidth={1.8} /> Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
