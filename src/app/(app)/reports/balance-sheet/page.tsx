import Link from 'next/link'
import { requireContext } from '@/server/context'
import { balanceSheet } from '@/server/services/reports/statements'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Alert } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../period-picker'
import type { BsSection } from '@/server/services/reports/statements'

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const bs = await balanceSheet(ctx, period.to, period.fyStart)

  const empty = bs.assets.lines.length === 0 && bs.liabilities.lines.length === 0 && bs.equity.lines.length === 0

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Balance Sheet" sub={`As at ${period.to.toISOString().slice(0, 10)}`}
        action={<div className="flex items-center gap-2"><ExportButton report="balance-sheet" fy={period.fyId} /><PeriodPicker options={period.options} value={period.fyId} /></div>} />

      {!bs.balanced && (
        <Alert tone="critical" title={`Out of balance by ${formatINR(bs.difference)}`}>
          A balance sheet that does not balance means the ledger itself is inconsistent, not that
          the report is wrong. Check the journal for an entry posted outside the double-entry
          service.
        </Alert>
      )}

      {empty ? (
        <Card><Empty icon="Scale" title="Nothing on the balance sheet yet"
          hint="Assets, liabilities and equity appear as transactions are posted. Nothing here is sample data." /></Card>
      ) : (
        <>
          <Card flush className="overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                <Side s={bs.assets} hideTotal />
                <tr style={{ background: 'var(--surface)' }}>
                  <td className="px-4 py-3 text-[14px] font-semibold">Total assets</td>
                  <td className="px-4 py-3 text-right text-[14px] font-semibold tabular">{formatINR(bs.totalAssets)}</td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card flush className="overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                <Side s={bs.liabilities} />
                <Side s={bs.equity} />
                <tr style={{ background: 'var(--surface)' }}>
                  <td className="px-4 py-3 text-[14px] font-semibold">Total liabilities and equity</td>
                  <td className="px-4 py-3 text-right text-[14px] font-semibold tabular">{formatINR(bs.totalLiabilitiesAndEquity)}</td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card className="p-4">
            <p className="eyebrow">Why current year profit appears here</p>
            <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              {formatINR(bs.currentYearProfit)} is this year&rsquo;s result from the Profit &amp; Loss, carried
              into equity. It is <strong>calculated, not posted</strong> &mdash; no journal entry touches it,
              because the figure changes with every transaction until the year is closed. Without it
              the statement could not balance, since income and expense accounts sit on neither side.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

function Side({ s, hideTotal }: { s: BsSection; hideTotal?: boolean }) {
  if (s.lines.length === 0) return null
  return (
    <>
      <tr style={{ background: 'var(--surface)' }}>
        <td colSpan={2} className="px-4 py-2 eyebrow">{s.label}</td>
      </tr>
      {s.lines.map((l) => (
        <tr key={l.code} className="border-t" style={{ borderColor: 'var(--rule)' }}>
          <td className="px-4 py-2.5">
            {l.derived ? (
              <span>
                <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.code}</span>
                <span className="ml-2.5">{l.name}</span>
                <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ background: 'var(--surface)', color: 'var(--text-muted)' }}>calculated</span>
              </span>
            ) : (
              <Link href={`/accounting/accounts/${l.code}`} className="hover:underline">
                <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.code}</span>
                <span className="ml-2.5">{l.name}</span>
              </Link>
            )}
          </td>
          <td className="px-4 py-2.5 text-right tabular">{formatINR(l.amount)}</td>
        </tr>
      ))}
      {!hideTotal && (
        <tr className="border-t-2" style={{ borderColor: 'var(--rule)' }}>
          <td className="px-4 py-2.5 font-medium">Total {s.label.toLowerCase()}</td>
          <td className="px-4 py-2.5 text-right font-medium tabular">{formatINR(s.total)}</td>
        </tr>
      )}
    </>
  )
}
