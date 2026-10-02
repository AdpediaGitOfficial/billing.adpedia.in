import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { previewPayroll } from '@/server/services/payroll/run'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty } from '@/components/ui/kit'
import { RunActions } from './actions-client'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelRunAction } from '../actions'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default async function PayrollRunsPage({ searchParams }: { searchParams: Promise<{ m?: string; y?: string }> }) {
  const ctx = await requireContext()
  const sp = await searchParams
  const now = new Date()
  const month = Number(sp.m) || now.getUTCMonth() + 1
  const year = Number(sp.y) || now.getUTCFullYear()

  const [preview, existing, runs] = await Promise.all([
    previewPayroll(ctx, month, year).catch(() => null),
    prisma.payrollRun.findFirst({ where: { companyId: ctx.companyId, month, year, cancelledAt: null } }),
    prisma.payrollRun.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 12 }),
  ])

  if (!preview) return <Card><Empty icon="CalendarX" title="Nothing to run" hint="No open financial year covers this month." /></Card>

  return (
    <div className="space-y-5">
      <PageHeader title={`Payroll — ${preview.label}`} sub={`${preview.payslips.length} on payroll`} />

      <div className="flex flex-wrap gap-2">
        {runs.map((r) => (
          <a key={r.id} href={`/payroll/runs?m=${r.month}&y=${r.year}`}>
            <Pill tone={r.status === 'PAID' ? 'good' : r.status === 'APPROVED' ? 'accent' : 'neutral'} dot>
              {MONTHS[r.month - 1].slice(0, 3)} {r.year}
            </Pill>
          </a>
        ))}
      </div>

      {preview.warnings.map((w) => (
        <Alert key={w} tone={w.includes('no annual tax estimate') || w.includes('cannot be computed') ? 'critical' : 'warn'}
          title={w.includes('allocation') ? 'Unallocated staff cost'
            : w.includes('estimate') ? 'Missing tax estimate'
            : w.includes('structure') ? 'No salary structure'
            : 'Check before approving'}>
          {w}
        </Alert>
      ))}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross" value={formatINR(preview.grossTotal, { decimals: false })} icon="Wallet" foot={`${preview.payslips.length} payslips`} />
        <StatCard label="TDS u/s 192" value={formatINR(preview.tdsTotal, { decimals: false })} icon="Landmark" foot="Deposit by the 7th" />
        <StatCard label="Profession tax" value={formatINR(preview.ptTotal, { decimals: false })} icon="Receipt"
          foot={preview.ptTotal.isZero() ? 'Falls due in Sep and Mar' : 'Half-yearly, to the local body'} />
        <StatCard label="Net payable" value={formatINR(preview.netTotal, { decimals: false })} icon="Banknote" tone="accent" />
      </div>

      <Card flush className="overflow-hidden">
        <CardHeader title="Payslips" className="p-5 pb-4" sub={preview.label} />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th className="px-4 py-2.5 text-left eyebrow">Employee</th>
              <th className="px-4 py-2.5 text-right eyebrow">Gross</th>
              <th className="px-4 py-2.5 text-right eyebrow">Prof. tax</th>
              <th className="px-4 py-2.5 text-right eyebrow">TDS 192</th>
              <th className="px-4 py-2.5 text-right eyebrow">Net</th>
            </tr></thead>
            <tbody>
              {preview.payslips.map((p) => (
                <tr key={p.employeeId} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2 font-medium">{p.employeeName}{p.isDirector && <Pill tone="accent">Director</Pill>}</span>
                    <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {p.allocation.map((a) => `${a.projectName} ${Number(a.percent)}%`).join(' · ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular">{formatINR(p.gross)}</td>
                  <td className="px-4 py-3 text-right tabular">
                    {p.professionTax.isZero() ? <span style={{ color: 'var(--text-muted)' }}>—</span> : formatINR(p.professionTax)}
                    {p.professionTaxNote && <span className="block text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{p.professionTaxNote}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular">
                    {p.tds.isZero() ? <span style={{ color: 'var(--critical)' }}>—</span> : formatINR(p.tds)}
                    <span className="block text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{p.tdsNote}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular">{formatINR(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RunActions month={month} year={year} runId={existing?.id ?? null} status={existing?.status ?? null} label={preview.label} />

      {existing && existing.status !== 'DRAFT' && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold">Reverse this run</p>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Posts a reversal of the salary cost{existing.status === 'PAID' ? ' and of the payment' : ''}, marks the
                s.192 deductions reversed so they leave the challan queue, and keeps the run and its payslips on file.
                The month can then be run again.
                {' '}Refused once the TDS is on a challan or the quarter&rsquo;s 24Q is filed — at that point the
                employee is already claiming the credit.
              </p>
            </div>
            <ReverseButton action={cancelRunAction} idName="runId" id={existing.id}
              label="cancel run" confirmLabel="Reverse it"
              prompt={`Why is ${preview.label} payroll being reversed?`} />
          </div>
        </Card>
      )}

      {runs.some((r) => r.cancelledAt) && (
        <Card className="p-4">
          <p className="eyebrow">Reversed runs</p>
          <ul className="mt-2 space-y-1.5 text-[12.5px]">
            {runs.filter((r) => r.cancelledAt).map((r) => (
              <li key={r.id} style={{ color: 'var(--text-muted)' }}>
                {MONTHS[r.month - 1]} {r.year} · {formatINR(r.netTotal.toString(), { decimals: false })} · {r.cancelReason}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
