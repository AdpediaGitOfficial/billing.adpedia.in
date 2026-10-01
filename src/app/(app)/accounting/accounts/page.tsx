import Link from 'next/link'
import { requireContext } from '@/server/context'
import { accountBalances } from '@/server/services/reports/ledger'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Pill } from '@/components/ui/kit'
import { PeriodPicker } from '../../reports/period-picker'
import type { AccountType } from '@prisma/client'

const ORDER: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']
const LABEL: Record<AccountType, string> = {
  ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', INCOME: 'Income', EXPENSE: 'Expenses',
}

export default async function ChartOfAccountsPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const balances = await accountBalances(ctx, period, { includeZero: true })

  return (
    <div className="space-y-5">
      <PageHeader title="Chart of Accounts" sub={`${balances.length} accounts · balances as at ${period.to.toISOString().slice(0, 10)}`}
        action={<PeriodPicker options={period.options} value={period.fyId} />} />

      {balances.length === 0 ? (
        <Card><Empty icon="ListTree" title="No accounts" hint="The chart is seeded when a company is created." /></Card>
      ) : (
        ORDER.map((type) => {
          const rows = balances.filter((b) => b.type === type)
          if (rows.length === 0) return null
          return (
            <Card key={type} flush className="overflow-hidden">
              <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                <span className="eyebrow">{LABEL[type]}</span>
              </div>
              <table className="w-full text-[13px]">
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.code} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                      <td className="px-4 py-2.5">
                        <Link href={`/accounting/accounts/${b.code}?fy=${period.fyId}`} className="hover:underline">
                          <span className="tabular" style={{ color: 'var(--text-muted)' }}>{b.code}</span>
                          <span className={`ml-2.5 ${b.parentCode ? '' : 'font-medium'}`}>{b.name}</span>
                        </Link>
                        {b.subType && <Pill tone="neutral">{b.subType}</Pill>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular"
                        style={b.closing.isZero() ? { color: 'var(--text-muted)' } : undefined}>
                        {b.closing.isZero() ? '—' : formatINR(b.closing)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        })
      )}
    </div>
  )
}
