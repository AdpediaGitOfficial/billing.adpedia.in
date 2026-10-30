import { redirect } from 'next/navigation'
import { getContext } from '@/server/context'
import { prisma } from '@/server/db'
import { navFor, mobileTabsFor } from '@/components/shell/nav'
import { Sidebar } from '@/components/shell/sidebar'
import { BottomTabs } from '@/components/shell/bottom-tabs'
import { Topbar } from '@/components/shell/topbar'
import { complianceAlerts } from '@/server/services/dashboard'
import { OfflineProvider } from '@/components/pwa/offline-provider'
import { IdleLock } from '@/components/pwa/idle-lock'
import { currentFinancialYear } from '@/server/services/accounting/period'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext()
  if (!ctx) redirect('/login')

  const [user, company, fy] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true } }),
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { legalName: true, tradeName: true, logoUrl: true } }),
    currentFinancialYear(ctx.companyId),
  ])
  const alerts = await complianceAlerts(ctx.companyId)
  // docs/82 §3 — with a second entity the rail becomes the way between them
  const memberships = await prisma.userCompany.count({ where: { userId: ctx.userId } })
  const name = company.tradeName ?? company.legalName

  return (
    <OfflineProvider>
    <div className="min-h-dvh" style={{ background: 'var(--app-bg)' }}>
      <Sidebar groups={navFor(ctx.role)} company={name} fyLabel={fy?.label} alerts={alerts.length}
        logoUrl={company.logoUrl} multi={memberships > 1} />
      <div className="transition-[padding] md:pl-[232px]">
        <Topbar name={user.name} role={ctx.role} fyLabel={fy?.label} alerts={alerts.length} />
        <main className="mx-auto max-w-[1400px] px-4 py-5 pb-24 md:px-6 md:py-7 md:pb-10">{children}</main>
      </div>
      <BottomTabs tabs={mobileTabsFor(ctx.role)} />
      <IdleLock />
    </div>
    </OfflineProvider>
  )
}
