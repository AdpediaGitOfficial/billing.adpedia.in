import { Fragment } from 'react'
import Link from 'next/link'
import { requireContext } from '@/server/context'
import { cashFlow } from '@/server/services/reports/cash-flow'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Alert, StatCard, statGrid } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../period-picker'

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const cf = await cashFlow(ctx, period)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Cash Flow" sub={`${period.label} · direct method, built from what moved through the bank`}
        action={<div className="flex items-center gap-2"><ExportButton report="cash-flow" fy={period.fyId} /><PeriodPicker options={period.options} value={period.fyId} /></div>} />

      {!cf.reconciles && (
        <Alert tone="critical" title={`Does not tie to the cash accounts — off by ${formatINR(cf.difference)}`}>
          The movements shown here should add up to the change in the bank and cash balances exactly.
          A difference means an entry touched cash in a way this report could not classify.
        </Alert>
      )}

      {cf.sections.length === 0 ? (
        <Card><Empty icon="Wallet" title={`No cash moved in ${period.label}`}
          hint="This is built from journal entries that touch a bank or cash account. Import and reconcile a statement and it fills in. Nothing here is sample data." /></Card>
      ) : (
        <>
          <div className={`${statGrid} sm:grid-cols-3`}>
            <StatCard label="Opening balance" value={formatINR(cf.opening, { decimals: false })} />
            <StatCard label="Net movement" value={formatINR(cf.netChange, { decimals: false })}
              tone={cf.netChange.lt(0) ? 'default' : 'accent'} />
            <StatCard label="Closing balance" value={formatINR(cf.closing, { decimals: false })} />
          </div>

          <Card flush className="overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'var(--surface)' }}>
                  <th className="px-4 py-2.5 text-left eyebrow">Account</th>
                  <th className="px-4 py-2.5 text-right eyebrow">In</th>
                  <th className="px-4 py-2.5 text-right eyebrow">Out</th>
                  <th className="px-4 py-2.5 text-right eyebrow">Net</th>
                </tr>
              </thead>
              <tbody>
                {cf.sections.map((s) => (
                  <Fragment key={s.bucket}>
                    <tr style={{ background: 'var(--surface)' }}>
                      <td colSpan={4} className="px-4 py-2 eyebrow">{s.label}</td>
                    </tr>
                    {s.lines.map((l) => (
                      <tr key={`${s.bucket}-${l.code}`} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                        <td className="px-4 py-2.5">
                          <Link href={`/accounting/accounts/${l.code}`} className="hover:underline">
                            <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.code}</span>
                            <span className="ml-2.5">{l.name}</span>
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular">{l.inflow.isZero() ? '—' : formatINR(l.inflow, { decimals: false })}</td>
                        <td className="px-4 py-2.5 text-right tabular">{l.outflow.isZero() ? '—' : formatINR(l.outflow, { decimals: false })}</td>
                        <td className="px-4 py-2.5 text-right tabular font-medium"
                          style={{ color: l.net.lt(0) ? 'var(--critical)' : undefined }}>
                          {formatINR(l.net, { decimals: false })}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2" style={{ borderColor: 'var(--rule)' }}>
                      <td colSpan={3} className="px-4 py-2.5 font-medium">Net cash from {s.label.toLowerCase()}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular"
                        style={{ color: s.net.lt(0) ? 'var(--critical)' : 'var(--good)' }}>
                        {formatINR(s.net, { decimals: false })}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="p-4">
            <p className="eyebrow">Direct method</p>
            <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Each line is real money that crossed the bank account, classified by what it was paid
              for or received against. It can be checked against the Axis statement line by line &mdash;
              which is the point. The indirect method starts from profit and adjusts it, and cannot
              be verified by eye.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
