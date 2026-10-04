import Link from 'next/link'
import { requireContext } from '@/server/context'
import { formatINR } from '@/lib/money'
import { currentFinancialYear } from '@/server/services/accounting/period'
import { advanceTaxPosition, listAdvanceTax } from '@/server/services/tax/advance-tax'
import { can } from '@/server/auth/permissions'
import {
  Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty, FigureCard, FigureList,
} from '@/components/ui/kit'
import { EstimateForm, PaymentForm } from './forms'

/**
 * Advance tax — docs/71.
 *
 * 🔴 The whole screen hangs off one number this system cannot derive, and says so. Taxable
 * income is not book profit: depreciation is computed differently, s.40 and s.43B disallow
 * things the P&L has already taken, and the rate depends on which regime was elected. The
 * books' own profit is shown as context for that conversation, never as the base of a
 * computation.
 */
export default async function AdvanceTaxPage() {
  const ctx = await requireContext()
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) {
    return (
      <div className="max-w-3xl space-y-5">
        <PageHeader title="Advance tax" />
        <Card><Empty icon="Calendar" title="No open financial year" /></Card>
      </div>
    )
  }

  const [position, payments] = await Promise.all([
    advanceTaxPosition(ctx, fy.id),
    listAdvanceTax(ctx, fy.id),
  ])
  const mayWrite = can(ctx.role, 'tax', 'write')
  const live = payments.filter((p) => !p.cancelledAt)

  return (
    <div className="space-y-5">
      <PageHeader title="Advance tax"
        sub={`FY ${position.fyLabel} · s.211 instalments, and what s.234C charges on a shortfall`} />

      {!position.estimate ? (
        <Alert tone="warn" title="Nothing here can be computed until the CA gives a figure">
          Advance tax is a percentage of <strong>the year&rsquo;s tax liability</strong>, and that is not something
          these books hold. Taxable income is not book profit — depreciation is computed differently, s.40 and
          s.43B disallow things the P&amp;L has already taken — and the rate itself depends on whether s.115BAA
          was elected. The dates below are statutory and stand either way.
          {position.profitBeforeTax && (
            <>
              {' '}For the conversation: the books show{' '}
              <strong>{formatINR(position.profitBeforeTax)}</strong> of profit before tax for the year so far.
              That is what the ledger says, and it is not the taxable income.
            </>
          )}
        </Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Estimated tax for the year" value={formatINR(position.estimate.amount, { decimals: false })}
            icon="Scale" foot={position.estimate.source ?? undefined} />
          <StatCard label="Paid so far" value={formatINR(position.paid, { decimals: false })}
            icon="Landmark" foot={`${live.length} challan${live.length === 1 ? '' : 's'}`} />
          <StatCard label="s.234C so far" value={formatINR(position.interestSoFar, { decimals: false })}
            icon="Clock" tone={position.interestSoFar.gt(0) ? 'accent' : 'default'}
            foot={position.interestSoFar.gt(0) ? 'on the instalments already past' : 'nothing running'} />
          <StatCard label="Profit before tax, per the books" value={position.profitBeforeTax ? formatINR(position.profitBeforeTax, { decimals: false }) : '—'}
            icon="TrendingUp" foot="context for the CA — not the taxable income" />
        </div>
      )}

      <Card flush className="overflow-hidden">
        <CardHeader title="The four instalments" className="p-5 pb-3"
          sub="Cumulative, not one quarter at a time — by 15 September the total paid must reach 45% of the year, not 45% on top of June's 15%." />

        <FigureList noun="instalments">
          {position.instalments.map((i) => (
            <FigureCard key={i.by}
              title={<span className="flex flex-wrap items-center gap-2">
                {i.dueOn.toISOString().slice(0, 10)}
                <Pill tone={i.passed ? (i.shortfall.gt(0) && !i.withinSafeHarbour ? 'critical' : 'good') : 'neutral'}>
                  {i.cumulativePct}% by this date
                </Pill>
                {i.withinSafeHarbour && <Pill tone="warn">inside the s.234C proviso</Pill>}
              </span>}
              sub={position.estimate ? undefined : 'amount pending the estimate'}
              figures={position.estimate ? [
                { label: 'Required', value: formatINR(i.required) },
                { label: 'Paid by then', value: formatINR(i.paid) },
                { label: 'Short', value: i.shortfall.isZero() ? '—' : formatINR(i.shortfall), muted: i.shortfall.isZero(), strong: i.shortfall.gt(0) },
                { label: `s.234C (${i.interestMonths}m)`, value: i.interest.isZero() ? '—' : formatINR(i.interest), muted: i.interest.isZero() },
              ] : []} />
          ))}
        </FigureList>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th className="px-4 py-2.5 text-left eyebrow">Due</th>
                <th className="px-4 py-2.5 text-left eyebrow">Cumulative</th>
                <th className="px-4 py-2.5 text-right eyebrow">Required</th>
                <th className="px-4 py-2.5 text-right eyebrow">Paid by then</th>
                <th className="px-4 py-2.5 text-right eyebrow">Short</th>
                <th className="px-4 py-2.5 text-right eyebrow">s.234C</th>
              </tr>
            </thead>
            <tbody>
              {position.instalments.map((i) => (
                <tr key={i.by} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-4 py-3 tabular">{i.dueOn.toISOString().slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      {i.cumulativePct}%
                      {/* 🔴 the harbour is named only where it differs from the requirement */}
                      {i.safeHarbourPct !== i.cumulativePct && (
                        <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                          no interest at {i.safeHarbourPct}%
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular">{position.estimate ? formatINR(i.required) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular">{formatINR(i.paid)}</td>
                  {/**
                    * 🔴 Red only once the date has PASSED.
                    *
                    * A December instalment shown in critical red in October is a figure that
                    * means nothing — nothing is owed yet, and the date is two months away. It
                    * is docs/56 §2's frightening monthly hole in a different place: after
                    * three of those nobody reads the screen. Before the date it is simply
                    * what is still to pay by then.
                    */}
                  <td className="px-4 py-3 text-right tabular"
                      style={i.passed && i.shortfall.gt(0) && !i.withinSafeHarbour
                        ? { color: 'var(--critical)', fontWeight: 600 }
                        : { color: 'var(--text-muted)' }}>
                    {!position.estimate ? '—' : i.shortfall.isZero() ? '—' : formatINR(i.shortfall)}
                    {!i.passed && i.shortfall.gt(0) && (
                      <span className="block text-[10.5px]">still to pay by then</span>
                    )}
                    {i.withinSafeHarbour && (
                      <span className="block text-[10.5px]">inside the proviso — no interest</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular" style={{ color: i.interest.gt(0) ? 'var(--critical)' : 'var(--text-muted)' }}>
                    {i.interest.isZero() ? '—' : formatINR(i.interest)}
                    <span className="block text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                      1% × {i.interestMonths}m
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 border-t px-5 py-4 text-[11.5px] leading-relaxed"
             style={{ borderColor: 'var(--rule)', color: 'var(--text-muted)' }}>
          {position.notes.map((n, i) => <p key={i}>{n}</p>)}
          <p>
            s.234C charges a <em>fixed</em> three months on each of the first three instalments and one on the
            last, whatever the actual delay. It is not the &ldquo;month or part of a month&rdquo; of s.234B, and
            it does not stop when the money is eventually paid.
          </p>
        </div>
      </Card>

      {mayWrite && (
        <Card>
          <CardHeader title={position.estimate ? 'Revise the estimate' : 'Record the CA’s estimate'} className="mb-4"
            sub="Superseded, never edited — an instalment paid against an earlier figure was correct when it was paid." />
          <EstimateForm financialYearId={fy.id} current={position.estimate ? position.estimate.amount.toFixed(2) : null} />
          {position.estimate?.note && (
            <p className="mt-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Current note: {position.estimate.note}
            </p>
          )}
        </Card>
      )}

      <Card flush className="overflow-hidden">
        <CardHeader title="Challans paid" className="p-5 pb-3"
          sub="Dr 1350 Advance Income Tax Paid, Cr the bank — an asset until the return settles it, never an expense." />
        {live.length === 0 ? (
          <div className="px-5 pb-5">
            <Empty icon="Landmark" title="Nothing paid yet"
              hint="Advance tax is paid on ITNS 280. The BSR code and challan serial are on the counterfoil, and together with the date they make the CIN." />
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {live.map((p) => (
              <div key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                <span className="tabular">{p.paidOn.toISOString().slice(0, 10)}</span>
                <span className="font-mono text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{p.cin}</span>
                <span className="font-semibold tabular">{formatINR(p.amount.toString())}</span>
              </div>
            ))}
          </div>
        )}
        {mayWrite && (
          <div className="border-t px-5 py-4" style={{ borderColor: 'var(--rule)' }}>
            <PaymentForm />
          </div>
        )}
      </Card>

      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        The instalment dates are on the{' '}
        <Link href="/tax/calendar" className="underline">compliance calendar</Link> whether or not an estimate
        exists — the dates are statutory and do not wait for one.
      </p>
    </div>
  )
}
