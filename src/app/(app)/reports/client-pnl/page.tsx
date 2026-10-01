import { requireContext } from '@/server/context'
import { clientPnl } from '@/server/services/reports/client-pnl'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, DataTable, Pill, type Column } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { CategoryBars } from '@/components/charts/category-bars'
import { PeriodPicker } from '../period-picker'

export default async function ClientPnlPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const rows = await clientPnl(ctx, period)

  type Row = (typeof rows)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Client', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.name}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.projectCount === 0 ? 'no projects' : `${r.projectCount} project${r.projectCount > 1 ? 's' : ''}`}
          </span>
        </>
      ) },
    { key: 'rev', header: 'Revenue', align: 'right', width: '15%', mobile: 'value',
      cell: (r) => <span className="font-semibold">{formatINR(r.revenue, { decimals: false })}</span> },
    { key: 'cost', header: 'Cost', align: 'right', width: '14%', mobile: false,
      cell: (r) => formatINR(r.totalCost, { decimals: false }) },
    { key: 'profit', header: 'Gross profit', align: 'right', width: '15%', mobile: false,
      cell: (r) => <span className="font-semibold" style={{ color: r.grossProfit.lt(0) ? 'var(--critical)' : undefined }}>
        {formatINR(r.grossProfit, { decimals: false })}
      </span> },
    { key: 'out', header: 'Outstanding', align: 'right', width: '15%', mobile: false,
      cell: (r) => r.outstanding.isZero()
        ? <span style={{ color: 'var(--text-muted)' }}>—</span>
        : formatINR(r.outstanding, { decimals: false }) },
    { key: 'margin', header: 'Margin', align: 'center', width: '12%', mobile: 'tag',
      cell: (r) => r.marginPct === null
        ? <Pill tone="neutral">no revenue</Pill>
        : <Pill tone={r.marginPct.gte(30) ? 'good' : r.marginPct.gte(10) ? 'warn' : 'critical'}>
            {r.marginPct.toFixed(1)}%
          </Pill> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Client P&amp;L"
        sub={`${period.label} · the same journal lines as the project view, grouped by who paid`}
        action={<div className="flex items-center gap-2"><ExportButton report="client-pnl" fy={period.fyId} /><PeriodPicker options={period.options} value={period.fyId} /></div>} />

      {rows.length === 0 ? (
        <Card><Empty icon="Users" title={`No client activity in ${period.label}`}
          hint="A client appears once an invoice, a cost tagged to them, or a cost on one of their projects is posted. Nothing here is sample data." /></Card>
      ) : (
        <>
          <Card flush className="overflow-hidden">
            <DataTable columns={cols} rows={rows} keyOf={(r) => r.customerId} />
          </Card>

          <Card>
            <p className="eyebrow mb-3">Revenue by client</p>
            <CategoryBars
              rows={rows.filter((r) => r.revenue.gt(0)).map((r) => ({ label: r.name, value: r.revenue.toNumber() }))}
              format="inr-whole"
            />
          </Card>
        </>
      )}
    </div>
  )
}
