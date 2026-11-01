import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { navFor } from '@/components/shell/nav'
import { Icon } from '@/components/shell/icon'
import { Card, PageHeader } from '@/components/ui/kit'
import { isGstRegistered } from '@/server/services/invoicing/document-type'
import { hasDrawings } from '@/server/services/equity/drawings'

/**
 * Everything a phone cannot reach from the tab bar — docs/83.
 *
 * 🔴 The sidebar is `hidden md:flex`, so on a phone the ONLY navigation is the five-slot tab
 * bar, whose fifth slot has always pointed here. This page did not exist. `/more` fell through
 * to the roadmap catch-all, which answered with *"Arriving in phase 1 — what is missing is the
 * screen"* and two buttons back to the dashboard.
 *
 * So a phone could reach four screens out of sixty-five. Projects, vendors, bills, expenses,
 * every report, every tax screen, all of Settings and the drawings register were unreachable —
 * and nothing failed, because the tab bar worked perfectly and the page it pointed at rendered.
 *
 * The list is `navFor` with the same arguments the sidebar is given, so a screen gated out of
 * one is gated out of both: a GST screen must not appear here for an unregistered entity, and
 * drawings must not appear for a company.
 */
export default async function MorePage() {
  const ctx = await requireContext()
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    select: { legalName: true, tradeName: true, gstRegistrationType: true, constitution: true },
  })

  const groups = navFor(ctx.role, {
    gstRegistered: isGstRegistered(company.gstRegistrationType),
    hasDrawings: hasDrawings(company.constitution),
  })

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Everything else"
        sub={`${company.tradeName ?? company.legalName} — the screens the tab bar has no room for.`} />

      {groups.map((g, gi) => (
        <Card key={gi} flush className="overflow-hidden">
          <p className="eyebrow px-5 pt-4 pb-1">{g.label || 'Overview'}</p>
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {g.items.map((item) => (
              <Link key={item.href} href={item.href}
                className="flex items-center gap-3 px-5 py-3.5 active:opacity-70"
                style={{ color: 'var(--text-primary)' }}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                  style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)' }}>
                  <Icon name={item.icon} size={17} strokeWidth={1.8} />
                </span>
                <span className="flex-1 truncate text-[14px] font-medium">{item.label}</span>
                {item.badge ? (
                  <span className="rounded-full px-1.5 text-[10px] font-bold"
                    style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>
                    {item.badge}
                  </span>
                ) : null}
                <Icon name="ChevronRight" size={16} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
              </Link>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
