import Link from 'next/link'
import { requireContext } from '@/server/context'
import { profitAndLoss } from '@/server/services/reports/statements'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Pill } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../period-picker'
import type { PnlSection } from '@/server/services/reports/statements'

export default async function PnlPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const pnl = await profitAndLoss(ctx, period)

  const hasActivity = !pnl.totalIncome.isZero() || !pnl.totalExpenses.isZero()

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Profit &amp; Loss" sub={`${period.label} · every figure is a sum of journal lines`}
        action={<div className="flex items-center gap-2"><ExportButton report="pnl" fy={period.fyId} /><PeriodPicker options={period.options} value={period.fyId} /></div>} />

      {!hasActivity ? (
        <Card><Empty icon="TrendingUp" title={`Nothing posted in ${period.label}`}
          hint="The P&L is built from the ledger, so it fills as invoices are sent, bills approved and payroll run. Nothing here is sample data." /></Card>
      ) : (
        <Card flush className="overflow-hidden">
          <table className="w-full text-[13px]">
            <tbody>
              <Section s={pnl.revenue} />
              <Total label="Revenue" value={pnl.revenue.total} />

              <Section s={pnl.directCosts} />
              <Total label="Direct costs" value={pnl.directCosts.total} />
              <Total label="Gross profit" value={pnl.grossProfit} strong
                note={pnl.revenue.total.gt(0) ? `${pnl.grossProfit.div(pnl.revenue.total).mul(100).toFixed(1)}% of revenue` : undefined} />

              <Section s={pnl.operatingExpenses} />
              <Total label="Operating expenses" value={pnl.operatingExpenses.total} />

              {pnl.otherIncome.lines.length > 0 && (
                <>
                  <Section s={pnl.otherIncome} />
                  <Total label="Other income" value={pnl.otherIncome.total} />
                </>
              )}

              <tr style={{ background: 'var(--surface)' }}>
                <td className="px-4 py-3.5 text-[14px] font-semibold">Net {pnl.netProfit.lt(0) ? 'loss' : 'profit'}</td>
                <td className="px-4 py-3.5 text-right">
                  <span className="text-[15px] font-semibold tabular"
                    style={{ color: pnl.netProfit.lt(0) ? 'var(--critical)' : 'var(--good)' }}>
                    {formatINR(pnl.netProfit)}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {hasActivity && pnl.marginPct !== null && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="eyebrow">Net margin</p>
              <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                Net result as a share of everything earned in {period.label}.
              </p>
            </div>
            <Pill tone={pnl.marginPct.gte(20) ? 'good' : pnl.marginPct.gte(0) ? 'warn' : 'critical'}>
              {pnl.marginPct.toFixed(1)}%
            </Pill>
          </div>
        </Card>
      )}
    </div>
  )
}

function Section({ s }: { s: PnlSection }) {
  if (s.lines.length === 0) return null
  return (
    <>
      <tr style={{ background: 'var(--surface)' }}>
        <td colSpan={2} className="px-4 py-2 eyebrow">{s.label}</td>
      </tr>
      {s.lines.map((l) => (
        <tr key={l.code} className="border-t" style={{ borderColor: 'var(--rule)' }}>
          <td className="px-4 py-2.5">
            <Link href={`/accounting/accounts/${l.code}`} className="hover:underline">
              <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.code}</span>
              <span className="ml-2.5">{l.name}</span>
            </Link>
          </td>
          <td className="px-4 py-2.5 text-right tabular">{formatINR(l.amount)}</td>
        </tr>
      ))}
    </>
  )
}

function Total({ label, value, strong, note }: { label: string; value: import('@/lib/money').Decimal; strong?: boolean; note?: string }) {
  return (
    <tr className="border-t-2" style={{ borderColor: 'var(--rule)' }}>
      <td className={`px-4 py-2.5 ${strong ? 'font-semibold' : 'font-medium'}`}>
        {label}
        {note && <span className="ml-2 text-[11.5px] font-normal" style={{ color: 'var(--text-muted)' }}>{note}</span>}
      </td>
      <td className={`px-4 py-2.5 text-right tabular ${strong ? 'font-semibold' : 'font-medium'}`}>{formatINR(value)}</td>
    </tr>
  )
}
