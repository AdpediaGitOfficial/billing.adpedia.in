import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { accountLedger } from '@/server/services/reports/ledger'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Button, StatCard, statGrid } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../../../reports/period-picker'

/** Where a journal entry came from, as a link back to the document that caused it. */
function sourceHref(sourceType: string, sourceId: string | null): string | null {
  if (!sourceId) return null
  switch (sourceType) {
    case 'INVOICE': return `/invoices/${sourceId}`
    case 'BILL': return `/bills/${sourceId}`
    default: return null
  }
}

export default async function AccountLedgerPage({ params, searchParams }: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ fy?: string }>
}) {
  const { code } = await params
  const { fy } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const led = await accountLedger(ctx, code, period)
  if (!led) notFound()

  const { account, lines } = led

  return (
    <div className="space-y-5">
      <PageHeader back={{ href: '/accounting/accounts', label: 'Chart of accounts' }} title={`${account.code} · ${account.name}`}
        sub={`${account.type.toLowerCase()} · ${period.label}`}
        action={
          <div className="flex flex-wrap gap-2">
            <ExportButton report="ledger" fy={period.fyId} account={account.code} label="Export ledger" />
            <PeriodPicker options={period.options} value={period.fyId} />
            <Link href="/accounting/trial-balance"><Button variant="ghost">Trial balance</Button></Link>
          </div>
        } />

      <div className={`${statGrid} sm:grid-cols-4`}>
        <StatCard label="Opening" value={formatINR(account.opening, { decimals: false })} />
        <StatCard label="Debits" value={formatINR(account.debit, { decimals: false })} />
        <StatCard label="Credits" value={formatINR(account.credit, { decimals: false })} />
        <StatCard label="Closing" value={formatINR(account.closing, { decimals: false })} tone="accent" />
      </div>

      {lines.length === 0 ? (
        <Card><Empty icon="BookOpen" title={`No movement in ${period.label}`}
          hint="This account carries no entries for the selected year." /></Card>
      ) : (
        <Card flush className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                <th className="px-4 py-2.5 text-left eyebrow">Date</th>
                <th className="px-3 py-2.5 text-left eyebrow">Entry</th>
                <th className="px-3 py-2.5 text-left eyebrow">Narration</th>
                <th className="px-3 py-2.5 text-right eyebrow">Debit</th>
                <th className="px-3 py-2.5 text-right eyebrow">Credit</th>
                <th className="px-4 py-2.5 text-right eyebrow">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                <td colSpan={5} className="px-4 py-2 text-[12px] font-medium">Opening balance</td>
                <td className="px-4 py-2 text-right tabular font-medium">{formatINR(account.opening)}</td>
              </tr>
              {lines.map((l) => {
                const href = sourceHref(l.sourceType, l.sourceId)
                return (
                  <tr key={l.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="px-4 py-2.5 tabular whitespace-nowrap">{l.date.toISOString().slice(0, 10)}</td>
                    <td className="px-3 py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>#{l.entryNo}</td>
                    <td className="px-3 py-2.5">
                      {href ? <Link href={href} className="hover:underline">{l.narration}</Link> : l.narration}
                      {l.lineNarration && (
                        <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{l.lineNarration}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">{l.debit.isZero() ? '' : formatINR(l.debit)}</td>
                    <td className="px-3 py-2.5 text-right tabular">{l.credit.isZero() ? '' : formatINR(l.credit)}</td>
                    <td className="px-4 py-2.5 text-right tabular font-medium">{formatINR(l.balance)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--surface)' }}>
                <td colSpan={3} className="px-4 py-3 font-semibold">Closing balance</td>
                <td className="px-3 py-3 text-right font-semibold tabular">{formatINR(account.debit)}</td>
                <td className="px-3 py-3 text-right font-semibold tabular">{formatINR(account.credit)}</td>
                <td className="px-4 py-3 text-right font-semibold tabular">{formatINR(account.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  )
}
