import Link from 'next/link'
import { requireContext } from '@/server/context'
import { resolvePeriod } from '@/server/services/reports/period'
import { Card, PageHeader } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'
import type { IconName } from '@/components/shell/icons'

const REPORTS: { href: string; icon: IconName; title: string; desc: string }[] = [
  { href: '/reports/pnl', icon: 'TrendingUp', title: 'Profit & Loss', desc: 'Revenue, direct cost and overhead for the year, straight from the ledger.' },
  { href: '/reports/balance-sheet', icon: 'Scale', title: 'Balance Sheet', desc: 'What is owned, what is owed and what is left, at a date.' },
  { href: '/reports/cash-flow', icon: 'Wallet', title: 'Cash Flow', desc: 'Direct method — every line checkable against the bank statement.' },
  { href: '/reports/ageing', icon: 'HandCoins', title: 'Ageing', desc: 'Who owes what, how late, net of the TDS they must withhold.' },
  { href: '/reports/client-pnl', icon: 'Users', title: 'Client P&L', desc: 'Margin by client, including cost that reached them through a project.' },
  { href: '/reports/project-pnl', icon: 'ChartPie', title: 'Project P&L', desc: 'Margin by project, once payroll is allocated.' },
  { href: '/accounting/trial-balance', icon: 'ListTree', title: 'Trial Balance', desc: 'Every account, opening to closing. The proof the books balance.' },
  { href: '/accounting/journal', icon: 'BookOpen', title: 'Journal', desc: 'The complete entry-by-entry record behind every figure above.' },
]

export default async function ReportsIndex() {
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId)

  return (
    <div className="space-y-5">
      <PageHeader title="Reports" sub={`${period.label} · every figure drills through to the journal lines behind it`} />

      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card className="h-full p-4 transition-colors hover:border-[var(--accent)]">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: 'var(--surface)' }}>
                  <Icon name={r.icon} className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold">{r.title}</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{r.desc}</p>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
