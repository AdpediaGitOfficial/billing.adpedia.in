import { requireContext } from '@/server/context'
import { projectPnl } from '@/server/services/reports/project-pnl'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, DataTable, Pill, type Column } from '@/components/ui/kit'
import { CategoryBars } from '@/components/charts/category-bars'

export default async function ProjectPnlPage() {
  const ctx = await requireContext()
  const rows = await projectPnl(ctx)
  const withActivity = rows.filter((r) => r.revenue.gt(0) || r.totalCost.gt(0))

  type Row = (typeof rows)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Project', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.name}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.customerName}</span>
        </>
      ) },
    { key: 'rev', header: 'Revenue', align: 'right', width: '14%', mobile: 'value',
      cell: (r) => <span className="font-semibold">{formatINR(r.revenue, { decimals: false })}</span> },
    { key: 'staff', header: 'Staff', align: 'right', width: '13%', mobile: false,
      cell: (r) => formatINR(r.staffCost, { decimals: false }) },
    { key: 'vendor', header: 'Vendors', align: 'right', width: '13%', mobile: false,
      cell: (r) => formatINR(r.vendorCost, { decimals: false }) },
    { key: 'profit', header: 'Gross profit', align: 'right', width: '15%', mobile: false,
      cell: (r) => <span className="font-semibold" style={{ color: r.grossProfit.lt(0) ? 'var(--critical)' : undefined }}>
        {formatINR(r.grossProfit, { decimals: false })}
      </span> },
    { key: 'margin', header: 'Margin', align: 'center', width: '12%', mobile: 'tag',
      cell: (r) => r.marginPct === null
        ? <Pill tone="neutral">no revenue</Pill>
        : <Pill tone={r.marginPct.gte(30) ? 'good' : r.marginPct.gte(10) ? 'warn' : 'critical'}>
            {r.marginPct.toFixed(1)}%
          </Pill> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Project P&amp;L"
        sub="Revenue less staff, vendor and other cost — all of it grouped from journal lines, not a second set of books." />

      {withActivity.length === 0 ? (
        <Card><Empty icon="ChartPie" title="No project activity yet"
          hint="Margins appear once invoices carry a project and payroll is allocated. Staff cost only reaches a project through the allocation." /></Card>
      ) : (
        <>
          <Card flush className="overflow-hidden">
            <DataTable columns={cols} rows={withActivity} keyOf={(r) => r.projectId} />
          </Card>

          <Card>
            <p className="eyebrow mb-3">Gross profit by project</p>
            <CategoryBars
              rows={withActivity.filter((r) => r.grossProfit.gt(0)).map((r) => ({ label: r.name, value: r.grossProfit.toNumber() }))}
              format="inr-whole"
            />
          </Card>
        </>
      )}
    </div>
  )
}
