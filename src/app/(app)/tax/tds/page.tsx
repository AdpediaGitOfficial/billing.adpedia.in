import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { outstandingDeductions } from '@/server/services/tax/tds-challan'
import { buildTdsReturn, type ReturnForm } from '@/server/services/tax/tds-return'
import { formatINR, Decimal, ZERO } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty, Button, DataTable, type Column } from '@/components/ui/kit'
import { ChallanForm } from './challan-form'
import { currentFinancialYear } from '@/server/services/accounting/period'

export default async function TdsPage({ searchParams }: { searchParams: Promise<{ q?: string; form?: string }> }) {
  const ctx = await requireContext()
  const sp = await searchParams

  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return <Card><Empty title="No open financial year" icon="CalendarX" /></Card>

  const quarter = (Number(sp.q) || 2) as 1 | 2 | 3 | 4
  const form = (sp.form ?? '26Q') as ReturnForm

  const [outstanding, ret, challans] = await Promise.all([
    outstandingDeductions(ctx),
    buildTdsReturn(ctx, form, fy.label, quarter),
    prisma.tdsChallan.findMany({ where: { companyId: ctx.companyId, financialYearId: fy.id }, orderBy: { depositedOn: 'desc' }, include: { deductions: true } }),
  ])

  const today = new Date()
  const overdue = outstanding.filter((d) => d.overdueDays > 0)
  const totalOwed = outstanding.reduce((a, d) => a.plus(d.tdsAmount), ZERO)
  const totalInterest = outstanding.reduce((a, d) => a.plus(d.interestIfPaidToday), ZERO)
  const nextDue = outstanding.length > 0 ? outstanding.map((d) => d.dueOn).sort((a, b) => a.getTime() - b.getTime())[0] : null

  const bySection = new Map<string, { amount: Decimal; ids: string[]; quarter: number }>()
  for (const d of outstanding) {
    const e = bySection.get(d.sectionCode) ?? { amount: ZERO, ids: [], quarter: d.quarter }
    bySection.set(d.sectionCode, { amount: e.amount.plus(d.tdsAmount), ids: [...e.ids, d.id], quarter: d.quarter })
  }

  type Row = (typeof outstanding)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Deductee', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.deducteeName}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.deducteePan ?? <span style={{ color: 'var(--critical)' }}>no PAN</span>} · {r.sectionCode}
          </span>
        </>
      ) },
    { key: 'deducted', header: 'Deducted', width: '12%', mobile: 'secondary',
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.deductedOn.toISOString().slice(0, 10)}</span> },
    { key: 'due', header: 'Due', width: '14%', align: 'center', mobile: 'tag',
      cell: (r) => <Pill dot tone={r.overdueDays > 0 ? 'critical' : 'accent'}>
        {r.overdueDays > 0 ? `${r.overdueDays}d overdue` : r.dueOn.toISOString().slice(0, 10)}
      </Pill> },
    { key: 'interest', header: 'Interest if paid today', width: '18%', align: 'right', mobile: false,
      cell: (r) => r.interestIfPaidToday.gt(0)
        ? <span className="tabular" style={{ color: 'var(--critical)' }}>{formatINR(r.interestIfPaidToday)}</span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'tds', header: 'TDS', width: '14%', align: 'right', mobile: 'value',
      cell: (r) => <span className="font-semibold">{formatINR(r.tdsAmount)}</span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="TDS" sub={`FY ${fy.label} · what you deduct and deposit`}
        action={
          <a href={`/api/tax/tds/export?form=${form}&fy=${fy.label}&quarter=${quarter}`}>
            <Button variant="ghost" icon="Download">{form} Q{quarter} CSV</Button>
          </a>
        } />

      {overdue.length > 0 && (
        <Alert tone="critical" title={`${overdue.length} deduction${overdue.length === 1 ? '' : 's'} past the deposit deadline`}>
          Interest runs at 1.5% a month, or part of a month — a single day late costs a full
          month. Paying today would add {formatINR(totalInterest)}.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="To deposit" value={formatINR(totalOwed, { decimals: false })} icon="Landmark"
          foot={`${outstanding.length} deduction${outstanding.length === 1 ? '' : 's'}`} tone={totalOwed.gt(0) ? 'accent' : 'default'} />
        <StatCard label="Next deadline" value={nextDue ? nextDue.toISOString().slice(0, 10) : '—'} icon="CalendarClock"
          foot={nextDue ? (nextDue < today ? 'Passed' : `${Math.ceil((nextDue.getTime() - today.getTime()) / 86400000)} days left`) : 'Nothing pending'} />
        <StatCard label="Interest if paid today" value={formatINR(totalInterest, { decimals: false })} icon="TrendingUp"
          foot="s.201(1A), 1.5% a month" />
        <StatCard label="Challans this year" value={String(challans.length)} icon="Receipt"
          foot={formatINR(challans.reduce((a, c) => a.plus(c.amount.toString()), ZERO), { decimals: false }) + ' deposited'} />
      </div>

      <Card flush className="overflow-hidden">
        <CardHeader title="Awaiting deposit" className="p-5 pb-4" sub="Grouped onto a challan by section" />
        <DataTable columns={cols} rows={outstanding} keyOf={(r) => r.id}
          empty={<Empty icon="CheckCircle2" title="Everything deducted has been deposited" hint="Nothing is owed to the government right now." />} />
      </Card>

      {bySection.size > 0 && (
        <Card>
          <CardHeader title="Record a challan" sub="One challan covers one section. The BSR code and serial are on the counterfoil." />
          <ChallanForm sections={[...bySection.entries()].map(([code, v]) => ({
            code, amount: v.amount.toFixed(2), ids: v.ids, quarter: v.quarter,
          }))} />
        </Card>
      )}

      {/* ── the return ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader title={`Form ${ret.form} — Q${ret.quarter}`}
          sub={`Due ${ret.dueOn.toISOString().slice(0, 10)} · Form 16${ret.form === '24Q' ? '' : 'A'} by ${ret.certificateDueOn.toISOString().slice(0, 10)}`}
          action={
            <div className="flex gap-1.5">
              {(['24Q', '26Q', '27Q'] as const).map((f) => (
                <a key={f} href={`/tax/tds?form=${f}&q=${quarter}`}>
                  <Pill tone={f === form ? 'accent' : 'neutral'}>{f}</Pill>
                </a>
              ))}
              {[1, 2, 3, 4].map((q) => (
                <a key={q} href={`/tax/tds?form=${form}&q=${q}`}>
                  <Pill tone={q === quarter ? 'accent' : 'neutral'}>Q{q}</Pill>
                </a>
              ))}
            </div>
          } />

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Pill dot tone={ret.readyToFile ? 'good' : 'critical'}>
            {ret.readyToFile ? 'Pre-flight passed' : 'Pre-flight failed'}
          </Pill>
          <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            {ret.deductees.length} deductee{ret.deductees.length === 1 ? '' : 's'} ·
            TDS {formatINR(ret.totals.tdsDeducted)} · challans {formatINR(ret.totals.challanTotal)}
          </span>
        </div>

        {ret.issues.length === 0 && ret.deductees.length > 0 && (
          <Alert tone="good" title="Nothing blocking">
            Every deductee has a valid PAN, every deduction is linked to a challan, and the
            challans reconcile. Export the CSV for your CA to import into the RPU.
          </Alert>
        )}

        <div className="space-y-2.5">
          {ret.issues.map((i, n) => (
            <Alert key={n} tone={i.severity === 'error' ? 'critical' : 'warn'}
              title={i.code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}>
              {i.message}
            </Alert>
          ))}
        </div>

        {ret.deductees.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr style={{ background: 'var(--surface-2)' }}>
                <th className="px-3 py-2 text-left eyebrow">Deductee</th>
                <th className="px-3 py-2 text-left eyebrow">PAN</th>
                <th className="px-3 py-2 text-center eyebrow">Section</th>
                <th className="px-3 py-2 text-right eyebrow">Paid</th>
                <th className="px-3 py-2 text-right eyebrow">TDS</th>
                <th className="px-3 py-2 text-center eyebrow">Challan</th>
              </tr></thead>
              <tbody>
                {ret.deductees.map((d, n) => (
                  <tr key={n} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="px-3 py-2">{d.deducteeName}</td>
                    <td className="px-3 py-2 tabular">
                      {d.deducteePan ?? <Pill tone="critical">missing</Pill>}
                      {d.reasonCode && <Pill tone="warn">code {d.reasonCode}</Pill>}
                    </td>
                    <td className="px-3 py-2 text-center">{d.sectionCode}</td>
                    <td className="px-3 py-2 text-right tabular">{formatINR(d.amountPaid, { decimals: false })}</td>
                    <td className="px-3 py-2 text-right tabular font-semibold">{formatINR(d.tdsDeducted)}</td>
                    <td className="px-3 py-2 text-center tabular" style={{ color: 'var(--text-muted)' }}>
                      {d.challanSerial ?? <Pill tone="critical">unlinked</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
