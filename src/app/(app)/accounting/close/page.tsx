import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { can } from '@/server/auth/permissions'
import { closingPreflight } from '@/server/services/accounting/close'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Pill, Alert, Empty } from '@/components/ui/kit'
import { CloseControls } from './controls'

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const mayLock = can(ctx.role, 'period.lock', 'approve')

  const years = await prisma.financialYear.findMany({
    where: { companyId: ctx.companyId }, orderBy: { startsOn: 'desc' },
  })
  const selected = years.find((y) => y.id === fy) ?? years.find((y) => y.status === 'OPEN') ?? years[0]

  if (!selected) {
    return (
      <div className="max-w-2xl space-y-5">
        <PageHeader title="Close the books" />
        <Card><Empty icon="Lock" title="No financial years on file" /></Card>
      </div>
    )
  }

  const pre = await closingPreflight(ctx, selected.id)

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Close the books"
        sub="Lock a period once its return is filed; close the year once the CA has signed it off." />

      {!mayLock && (
        <Alert tone="info" title="You can see this but not act on it">
          Locking and closing need the owner&rsquo;s approval rights.
        </Alert>
      )}

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">Financial years</span>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {years.map((y) => (
              <tr key={y.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5 font-medium">FY {y.label}</td>
                <td className="px-4 py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>
                  {y.lockedUpTo ? `locked to ${y.lockedUpTo.toISOString().slice(0, 10)}` : 'not locked'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Pill tone={y.status === 'OPEN' ? 'good' : 'neutral'}>{y.status.toLowerCase()}</Pill>
                  {y.id === selected.id && <Pill tone="accent">selected</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">Before FY {pre.fyLabel} can be closed</span>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {pre.checks.map((c) => (
              <tr key={c.label} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5 w-[38%]">
                  {c.label}
                  {!c.blocking && (
                    <span className="ml-2 text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      advisory
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5" style={{ color: c.ok ? 'var(--text-muted)' : c.blocking ? 'var(--critical)' : 'var(--warn)' }}>
                  {c.detail}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Pill tone={c.ok ? 'good' : c.blocking ? 'critical' : 'warn'}>{c.ok ? 'ok' : c.blocking ? 'blocks' : 'check'}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {pre.canClose && selected.status === 'OPEN' && (
        <Alert tone="warn" title={`Closing will move ${formatINR(pre.netProfit)} to retained earnings`}>
          A single entry dated {selected.endsOn.toISOString().slice(0, 10)} zeroes{' '}
          {pre.accountsToSweep} income and expense accounts and books the result to{' '}
          <strong>3100 Retained Earnings</strong>. After that the year is locked — a correction
          has to be posted in the next year instead.
        </Alert>
      )}

      {mayLock && (
        <CloseControls
          fyId={selected.id}
          fyLabel={selected.label}
          status={selected.status}
          lockedUpTo={selected.lockedUpTo ? selected.lockedUpTo.toISOString().slice(0, 10) : null}
          startsOn={selected.startsOn.toISOString().slice(0, 10)}
          endsOn={selected.endsOn.toISOString().slice(0, 10)}
          canClose={pre.canClose}
          needsNextFy={!pre.checks.find((c) => c.label === 'A following year exists')?.ok}
        />
      )}

      <Card className="p-4">
        <p className="eyebrow">What locking actually does</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Every posting path in this system calls the same guard, so a locked date is refused
          whether the entry comes from an invoice, a bill, payroll or a bank match. Lock a month
          once its GST return is filed &mdash; that is the point after which a change to it would
          quietly make the filed return wrong.
        </p>
      </Card>
    </div>
  )
}
