import Link from 'next/link'
import { requireContext } from '@/server/context'
import { projectPnl } from '@/server/services/reports/project-pnl'
import { prisma } from '@/server/db'
import { formatINR, Decimal } from '@/lib/money'
import { Card, PageHeader, Button, Empty, Pill, DataTable, ProgressBar, type Column, type Tone } from '@/components/ui/kit'
import type { ProjectStatus } from '@prisma/client'

const TONE: Record<ProjectStatus, Tone> = {
  PROSPECT: 'neutral', ACTIVE: 'accent', COMPLETED: 'good', ON_HOLD: 'warn', CANCELLED: 'neutral',
}

export default async function ProjectsPage() {
  const ctx = await requireContext()
  const [projects, pnl] = await Promise.all([
    prisma.project.findMany({
      where: { companyId: ctx.companyId },
      include: { customer: { select: { name: true } }, _count: { select: { invoices: true } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    }),
    projectPnl(ctx).catch(() => []),
  ])
  const byId = new Map(pnl.map((p) => [p.projectId, p]))

  type Row = (typeof projects)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Project', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.name}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.code} · {r.customer.name}
          </span>
        </>
      ) },
    { key: 'rev', header: 'Revenue', align: 'right', width: '14%', mobile: 'value',
      cell: (r) => {
        const p = byId.get(r.id)
        return p ? <span className="font-semibold tabular">{formatINR(p.revenue, { decimals: false })}</span>
                 : <span style={{ color: 'var(--text-muted)' }}>—</span>
      } },
    { key: 'cost', header: 'Cost', align: 'right', width: '13%', mobile: false,
      cell: (r) => {
        const p = byId.get(r.id)
        return p ? formatINR(p.totalCost, { decimals: false }) : '—'
      } },
    { key: 'contract', header: 'Contract (ex GST)', align: 'right', width: '14%', mobile: false,
      cell: (r) => r.contractValue
        ? formatINR(r.contractValue.toString(), { decimals: false })
        : <span style={{ color: 'var(--text-muted)' }}>not set</span> },
    { key: 'margin', header: 'Margin', align: 'center', width: '12%', mobile: 'tag',
      cell: (r) => {
        const p = byId.get(r.id)
        if (!p || p.marginPct === null) return <Pill tone="neutral">no revenue</Pill>
        return <Pill tone={p.marginPct.gte(30) ? 'good' : p.marginPct.gte(10) ? 'warn' : 'critical'}>
          {p.marginPct.toFixed(1)}%
        </Pill>
      } },
    { key: 'status', header: 'Status', align: 'center', width: '12%', mobile: false,
      cell: (r) => <Pill tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'edit', header: '', width: '8%', align: 'right', mobile: false,
      cell: (r) => (
        <Link href={`/projects/${r.id}/edit`} className="text-[12px] underline underline-offset-2"
          style={{ color: 'var(--accent)' }}>edit</Link>
      ) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Projects"
        sub="What makes margin real — a cost only reaches a project if it is tagged to one."
        action={<Link href="/projects/new"><Button>New project</Button></Link>} />

      {projects.length === 0 ? (
        <Card><Empty icon="FolderKanban" title="No projects yet"
          hint="Tag invoices, bills and payroll allocations to a project and the margin on each appears here and on the Project P&L report."
          action={<Link href="/projects/new"><Button>New project</Button></Link>} /></Card>
      ) : (
        <>
          <Card flush className="overflow-hidden">
            <DataTable columns={cols} rows={projects} keyOf={(r) => r.id} />
          </Card>

          {projects.some((p) => p.contractValue) && (
            <Card className="p-4">
              <p className="eyebrow mb-3">Billed against contract value — both excluding GST</p>
              <div className="space-y-3">
                {projects.filter((p) => p.contractValue).map((p) => {
                  const billed = byId.get(p.id)?.revenue ?? new Decimal(0)
                  const contract = new Decimal(p.contractValue!.toString())
                  return (
                    <ProgressBar key={p.id}
                      value={Math.min(billed.div(contract).mul(100).toNumber(), 100)} max={100}
                      label={p.name}
                      right={`${formatINR(billed, { decimals: false })} of ${formatINR(contract, { decimals: false })}`}
                      tone={billed.gte(contract) ? 'good' : 'accent'} />
                  )
                })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
