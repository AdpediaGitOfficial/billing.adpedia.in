import Link from 'next/link'
import { requireContext } from '@/server/context'
import { trialBalance } from '@/server/services/reports/statements'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Alert, FigureCard, FigureList } from '@/components/ui/kit'
import { ExportButton, StatementPdfButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../../reports/period-picker'

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const tb = await trialBalance(ctx, period)

  return (
    <div className="space-y-5">
      <PageHeader title="Trial Balance" sub={`${period.label} · opening, movement and closing for every account`}
        action={<div className="flex items-center gap-2"><StatementPdfButton statement="trial-balance" fy={period.fyId} /><ExportButton report="trial-balance" fy={period.fyId} /><PeriodPicker options={period.options} value={period.fyId} /></div>} />

      {tb.balanced ? (
        <Alert tone="good" title="Debits equal credits">
          Every entry in the ledger is balanced, and the two closing columns agree to the paisa.
          This is checked on write by a database constraint as well as here.
        </Alert>
      ) : (
        <Alert tone="critical" title={`Out of balance by ${formatINR(tb.difference)}`}>
          This should be impossible &mdash; the journal service and a deferred database trigger both
          refuse an unbalanced entry. Treat it as data corruption and check the journal.
        </Alert>
      )}

      {tb.rows.length === 0 ? (
        <Card><Empty icon="Scale" title={`Nothing posted in ${period.label}`}
          hint="Accounts appear here once they carry a balance or a movement. Nothing here is sample data." /></Card>
      ) : (
        <Card flush className="overflow-hidden">
          {/* docs/68 §7 — the figures wrap on a phone rather than the grid scrolling sideways */}
          <FigureList noun="accounts">
            {tb.rows.map((r) => (
              <FigureCard key={r.code}
                href={`/accounting/accounts/${r.code}?fy=${period.fyId}`}
                title={r.name} sub={r.code}
                figures={[
                  { label: 'Opening Dr', value: formatINR(r.openingDr), muted: Number(r.openingDr) === 0 },
                  { label: 'Opening Cr', value: formatINR(r.openingCr), muted: Number(r.openingCr) === 0 },
                  { label: 'Debit', value: formatINR(r.debit), muted: Number(r.debit) === 0 },
                  { label: 'Credit', value: formatINR(r.credit), muted: Number(r.credit) === 0 },
                  { label: 'Closing Dr', value: formatINR(r.closingDr), strong: true, muted: Number(r.closingDr) === 0 },
                  { label: 'Closing Cr', value: formatINR(r.closingCr), strong: true, muted: Number(r.closingCr) === 0 },
                ]} />
            ))}
          </FigureList>
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                <th className="px-4 py-2.5 text-left eyebrow">Account</th>
                <th className="px-3 py-2.5 text-right eyebrow">Opening Dr</th>
                <th className="px-3 py-2.5 text-right eyebrow">Opening Cr</th>
                <th className="px-3 py-2.5 text-right eyebrow">Debit</th>
                <th className="px-3 py-2.5 text-right eyebrow">Credit</th>
                <th className="px-3 py-2.5 text-right eyebrow">Closing Dr</th>
                <th className="px-4 py-2.5 text-right eyebrow">Closing Cr</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r) => (
                <tr key={r.code} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-4 py-2.5">
                    <Link href={`/accounting/accounts/${r.code}?fy=${period.fyId}`} className="hover:underline">
                      <span className="tabular" style={{ color: 'var(--text-muted)' }}>{r.code}</span>
                      <span className="ml-2.5">{r.name}</span>
                    </Link>
                  </td>
                  <Num v={r.openingDr} /><Num v={r.openingCr} />
                  <Num v={r.debit} /><Num v={r.credit} />
                  <Num v={r.closingDr} strong /><Num v={r.closingCr} strong last />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--surface)' }}>
                <td className="px-4 py-3 font-semibold">Totals</td>
                <td colSpan={2} />
                <td className="px-3 py-3 text-right font-semibold tabular">{formatINR(tb.totals.debit)}</td>
                <td className="px-3 py-3 text-right font-semibold tabular">{formatINR(tb.totals.credit)}</td>
                <td className="px-3 py-3 text-right font-semibold tabular">{formatINR(tb.totals.closingDr)}</td>
                <td className="px-4 py-3 text-right font-semibold tabular">{formatINR(tb.totals.closingCr)}</td>
              </tr>
            </tfoot>
          </table>
          </div>
          {/* the totals, which the cards above do not carry */}
          <div className="flex items-center justify-between border-t px-4 py-3 text-[12.5px] md:hidden"
               style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
            <span className="font-semibold">Totals</span>
            <span className="tabular">Dr {formatINR(tb.totals.closingDr)} · Cr {formatINR(tb.totals.closingCr)}</span>
          </div>
        </Card>
      )}
    </div>
  )
}

function Num({ v, strong, last }: { v: import('@/lib/money').Decimal; strong?: boolean; last?: boolean }) {
  return (
    <td className={`${last ? 'px-4' : 'px-3'} py-2.5 text-right tabular ${strong ? 'font-medium' : ''}`}
      style={v.isZero() ? { color: 'var(--text-muted)' } : undefined}>
      {v.isZero() ? '—' : formatINR(v)}
    </td>
  )
}
