import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR, Decimal } from '@/lib/money'
import { Card, PageHeader, Pill, Empty, DataTable, Alert, type Column } from '@/components/ui/kit'
import { EstimateForm } from './estimate-form'
import { currentFinancialYear } from '@/server/services/accounting/period'

export default async function EmployeesPage() {
  const ctx = await requireContext()
  const fy = await currentFinancialYear(ctx.companyId)

  const employees = await prisma.employee.findMany({
    where: { companyId: ctx.companyId, OR: [{ leftOn: null }, { leftOn: { gte: new Date() } }] },
    include: {
      structures: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
      allocations: { include: { project: { select: { name: true } } } },
      salaryTaxEstimates: { where: { supersededAt: null }, take: 1 },
    },
    orderBy: [{ isDirector: 'desc' }, { name: 'asc' }],
  })

  const missingEstimate = employees.filter((e) => e.salaryTaxEstimates.length === 0)
  const annualGross = employees.reduce((a, e) => a.plus(new Decimal(e.structures[0]?.grossMonthly.toString() ?? 0).mul(12)), new Decimal(0))

  type Row = (typeof employees)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Employee', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="flex items-center gap-2 font-medium">
            {r.name}{r.isDirector && <Pill tone="accent">Director</Pill>}
          </span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.employeeCode} · {r.designation}</span>
        </>
      ) },
    { key: 'gross', header: 'Monthly gross', width: '15%', align: 'right', mobile: 'value',
      cell: (r) => r.structures[0]
        ? <span className="font-semibold">{formatINR(r.structures[0].grossMonthly.toString(), { decimals: false })}</span>
        : <Pill tone="critical">no structure</Pill> },
    { key: 'estimate', header: 'Annual tax estimate', width: '20%', align: 'right', mobile: false,
      cell: (r) => r.salaryTaxEstimates[0]
        ? <span className="tabular">{formatINR(r.salaryTaxEstimates[0].estimatedAnnualTax.toString(), { decimals: false })}</span>
        : <Pill tone="critical" dot>not supplied</Pill> },
    { key: 'alloc', header: 'Allocation', width: '26%', mobile: 'tag',
      cell: (r) => r.allocations.length === 0
        ? <Pill tone="warn" dot>unallocated</Pill>
        : <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {r.allocations.map((a) => `${a.project?.name ?? 'Internal'} ${Number(a.percent)}%`).join(' · ')}
          </span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Employees" sub={`${employees.length} on payroll · ${formatINR(annualGross, { decimals: false })} annual gross`} />

      {missingEstimate.length > 0 && (
        <Alert tone="critical" title={`${missingEstimate.length} ${missingEstimate.length === 1 ? 'employee has' : 'employees have'} no annual tax estimate`}>
          Section 192 TDS is 1/12 of the estimated annual liability, not a flat rate — so nothing
          is deducted for {missingEstimate.map((e) => e.name).join(', ')} until the CA supplies a
          figure. Under-deduction carries interest at 1% a month.
        </Alert>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={employees} keyOf={(r) => r.id}
          empty={<Empty icon="IdCard" title="Nobody on payroll yet" />} />
      </Card>

      {fy && (
        <Card>
          <EstimateForm
            fyLabel={fy.label}
            employees={employees.map((e) => ({
              id: e.id, name: e.name,
              current: e.salaryTaxEstimates[0]?.estimatedAnnualTax.toString() ?? '',
            }))}
          />
        </Card>
      )}
    </div>
  )
}
