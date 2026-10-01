import Link from 'next/link'
import { requireContext } from '@/server/context'
import { receivablesAgeing, payablesAgeing, BUCKETS, type Ageing } from '@/server/services/reports/ageing'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Empty, Pill, Alert } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'

export default async function AgeingPage({ searchParams }: { searchParams: Promise<{ side?: string }> }) {
  const { side } = await searchParams
  const ctx = await requireContext()
  const showing: 'ar' | 'ap' = side === 'ap' ? 'ap' : 'ar'
  const data = showing === 'ap' ? await payablesAgeing(ctx) : await receivablesAgeing(ctx)

  return (
    <div className="space-y-5">
      <PageHeader
        title={showing === 'ap' ? 'Payables ageing' : 'Receivables ageing'}
        sub={`As at ${data.asOf.toISOString().slice(0, 10)} · bucketed by how far past due`}
        action={
          <div className="flex items-center gap-2">
            <ExportButton report={showing === 'ap' ? 'ageing-ap' : 'ageing-ar'} />
            <div className="flex gap-1.5 rounded-lg border p-1" style={{ borderColor: 'var(--rule)' }}>
              <Tab href="/reports/ageing?side=ar" active={showing === 'ar'}>Receivable</Tab>
              <Tab href="/reports/ageing?side=ap" active={showing === 'ap'}>Payable</Tab>
            </div>
          </div>
        } />

      {showing === 'ar' && data.tdsWithheldTotal.gt(0) && (
        <Alert tone="warn" title={`${formatINR(data.tdsWithheldTotal)} of this is TDS, not client debt`}>
          Clients are required to withhold that amount and pay it to the government, so it is excluded
          from the balances below. Chasing it is chasing a payment they cannot legally make &mdash; it is
          collected by getting it onto Form 26AS instead.
        </Alert>
      )}

      {data.parties.length === 0 ? (
        <Card><Empty icon="HandCoins"
          title={showing === 'ap' ? 'Nothing outstanding to vendors' : 'Nothing outstanding from clients'}
          hint={showing === 'ap'
            ? 'Approved bills appear here until they are paid. Nothing here is sample data.'
            : 'Sent invoices appear here until they are settled. Nothing here is sample data.'} /></Card>
      ) : (
        <>
          <Card flush className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13px]">
              <thead>
                <tr style={{ background: 'var(--surface)' }}>
                  <th className="px-4 py-2.5 text-left eyebrow">{showing === 'ap' ? 'Vendor' : 'Client'}</th>
                  {BUCKETS.map((b) => <th key={b} className="px-3 py-2.5 text-right eyebrow">{b}</th>)}
                  <th className="px-4 py-2.5 text-right eyebrow">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.parties.map((p) => (
                  <tr key={p.partyId} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="px-4 py-2.5 font-medium">{p.partyName}</td>
                    {BUCKETS.map((b) => (
                      <td key={b} className="px-3 py-2.5 text-right tabular"
                        style={p.buckets[b].isZero() ? { color: 'var(--text-muted)' }
                          : b === '90+' ? { color: 'var(--critical)', fontWeight: 600 } : undefined}>
                        {p.buckets[b].isZero() ? '—' : formatINR(p.buckets[b], { decimals: false })}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-semibold tabular">{formatINR(p.total, { decimals: false })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--surface)' }}>
                  <td className="px-4 py-3 font-semibold">Total</td>
                  {BUCKETS.map((b) => (
                    <td key={b} className="px-3 py-3 text-right font-semibold tabular">
                      {data.totals[b].isZero() ? '—' : formatINR(data.totals[b], { decimals: false })}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right font-semibold tabular">{formatINR(data.grandTotal, { decimals: false })}</td>
                </tr>
              </tfoot>
            </table>
          </Card>

          <DocList data={data} showing={showing} />
        </>
      )}
    </div>
  )
}

function DocList({ data, showing }: { data: Ageing; showing: 'ar' | 'ap' }) {
  const docs = data.parties.flatMap((p) => p.docs).sort((a, b) => b.daysOverdue - a.daysOverdue)
  return (
    <Card flush className="overflow-x-auto">
      <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
        <span className="eyebrow">Oldest first</span>
      </div>
      <table className="w-full min-w-[620px] text-[13px]">
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
              <td className="px-4 py-2.5">
                <Link href={showing === 'ap' ? `/bills/${d.id}` : `/invoices/${d.id}`} className="font-medium hover:underline">
                  {d.number}
                </Link>
                <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{d.partyName}</span>
              </td>
              <td className="px-3 py-2.5 tabular whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                due {d.dueDate.toISOString().slice(0, 10)}
              </td>
              <td className="px-3 py-2.5 text-center">
                {d.daysOverdue <= 0
                  ? <Pill tone="neutral">not due</Pill>
                  : <Pill tone={d.daysOverdue > 90 ? 'critical' : d.daysOverdue > 30 ? 'warn' : 'neutral'}>
                      {d.daysOverdue} days late
                    </Pill>}
              </td>
              <td className="px-4 py-2.5 text-right font-semibold tabular">{formatINR(d.outstanding)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className="rounded-md px-3 py-1 text-[13px] font-medium"
      style={active
        ? { background: 'var(--accent)', color: 'var(--on-accent)' }
        : { color: 'var(--text-muted)' }}>
      {children}
    </Link>
  )
}
