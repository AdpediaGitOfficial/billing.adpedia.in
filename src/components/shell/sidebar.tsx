'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from './icon'
import type { NavGroup } from './nav'

export function Sidebar({ groups, company, fyLabel, alerts = 0, logoUrl, multi = false }: {
  groups: NavGroup[]; company: string; fyLabel?: string; alerts?: number
  /** this entity's own mark, if it has one — docs/82 §3 */
  logoUrl?: string | null
  /** this user belongs to more than one entity, so the rail is also the way between them */
  multi?: boolean
}) {
  const path = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside
      className={cn('no-print hidden md:flex md:flex-col md:fixed md:inset-y-0 md:z-30 border-r transition-[width] duration-200',
        collapsed ? 'md:w-[68px]' : 'md:w-[232px]')}
      style={{ borderColor: 'var(--rule)', background: 'var(--rail)' }}
    >
      {/*
        🔴 docs/82 §3 — WHICH BOOKS AM I IN.
        This read `fyLabel ? \`FY ${fyLabel}\` : company`, so as soon as a financial year
        existed the entity's name disappeared — and every entity shows the same "FY 2026-27".
        The logo and the avatar letter were Adpedia's, hardcoded, so a second company's books
        were branded as the first one's. With two taxpayers under one login that is the
        difference between raising an invoice and raising it against the wrong person.
      */}
      <CompanyBadge
        company={company} fyLabel={fyLabel} logoUrl={logoUrl} multi={multi} collapsed={collapsed}
      />

      <nav className="flex-1 overflow-y-auto px-2.5 pb-2">
        {groups.map((g, gi) => (
          <div key={gi} className="mb-1">
            {g.label && !collapsed && <p className="eyebrow px-2.5 pb-1 pt-3">{g.label}</p>}
            {g.label && collapsed && <div className="mx-3 my-2.5 border-t" style={{ borderColor: 'var(--rule)' }} />}
            {g.items.map((item) => {
              const active = path === item.href || path.startsWith(item.href + '/')
              return (
                <Link key={item.href} href={item.href} title={collapsed ? item.label : undefined}
                  className={cn('group relative mb-0.5 flex items-center gap-2.5 rounded-lg py-[7px] text-[13px] transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-2.5')}
                  style={active
                    ? { background: 'var(--accent)', color: '#fff', fontWeight: 600 }
                    : { color: 'var(--text-secondary)' }}>
                  <Icon name={item.icon} size={16} strokeWidth={active ? 2.2 : 1.8} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {!collapsed && item.badge ? (
                    <span className="ml-auto rounded-full px-1.5 text-[10px] font-bold"
                          style={{ background: active ? 'rgba(255,255,255,.22)' : 'var(--critical-soft)', color: active ? '#fff' : 'var(--critical)' }}>
                      {item.badge}
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {!collapsed && alerts > 0 && (
        <div className="mx-2.5 mb-2 rounded-xl p-3" style={{ background: 'var(--critical-soft)' }}>
          <div className="flex items-center gap-1.5">
            <Icon name="AlertTriangle" size={13} strokeWidth={2.2} style={{ color: 'var(--critical)' }} />
            <p className="text-[11.5px] font-semibold" style={{ color: 'var(--critical)' }}>
              {alerts} compliance {alerts === 1 ? 'item' : 'items'}
            </p>
          </div>
          <Link href="/dashboard" className="mt-1 block text-[11px] underline" style={{ color: 'var(--critical)' }}>
            Review on the dashboard
          </Link>
        </div>
      )}

      <button onClick={() => setCollapsed((v) => !v)}
        className="mx-2.5 mb-3 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px]"
        style={{ color: 'var(--text-muted)' }}>
        <Icon name={collapsed ? 'PanelLeftOpen' : 'PanelLeftClose'} size={15} strokeWidth={1.8} />
        {!collapsed && 'Collapse'}
      </button>
    </aside>
  )
}

function CompanyBadge({ company, fyLabel, logoUrl, multi, collapsed }: {
  company: string; fyLabel?: string; logoUrl?: string | null; multi: boolean; collapsed: boolean
}) {
  const inner = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: 'var(--accent)' }}>
        <span className="text-[14px] font-bold text-white">{company.trim()[0]?.toUpperCase() ?? '?'}</span>
      </span>
      {!collapsed && (
        <div className="min-w-0">
          {logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} alt={company} className="h-[13px] w-auto" />
            : <p className="truncate text-[12px] font-semibold leading-tight">{company}</p>}
          {/*
            🔴 Found by looking at it. With the name and the hint in one truncating line, a long
            legal name — "ADPEDIA FILMS PRIVATE LIMITED" — ate the word "switch" entirely, which
            is the one affordance that has to survive. Name truncates, hint does not.
          */}
          <p className="mt-0.5 flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span className="truncate">{logoUrl ? company : fyLabel ? `FY ${fyLabel}` : ''}</span>
            {multi && <span className="shrink-0" style={{ color: 'var(--accent)' }}>· switch</span>}
          </p>
        </div>
      )}
    </>
  )

  const className = cn('flex items-center gap-2.5 px-4 py-4', collapsed && 'justify-center px-0')
  return multi
    ? <Link href="/settings/companies" title="Switch company" className={className}>{inner}</Link>
    : <div className={className}>{inner}</div>
}
