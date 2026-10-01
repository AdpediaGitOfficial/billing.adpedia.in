'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Icon } from './icon'
import type { NavItem } from './nav'

/** docs/13 §2.2 — max 5 slots, thumb-reachable, the 5th is always More. */
export function BottomTabs({ tabs }: { tabs: NavItem[] }) {
  const path = usePathname()
  const slots = [...tabs.slice(0, 4), { label: 'More', href: '/more', cap: 'dashboard' as const, icon: 'Menu' }]
  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t grid"
      style={{
        borderColor: 'var(--rule)',
        background: 'var(--surface-1)',
        gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))`,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {slots.map((t) => {
        const active = path === t.href || path.startsWith(t.href + '/')
        return (
          <Link key={t.href} href={t.href}
            className={cn('flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] text-[10px]')}
            style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}>
            <Icon name={t.icon} size={20} strokeWidth={active ? 2.3 : 1.8} />
            <span className={active ? 'font-semibold' : ''}>{t.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
