import Link from 'next/link'
import { requireContext } from '@/server/context'
import { invoicesNeedingRebook } from '@/server/services/invoicing/rebook'
import { PageHeader, Card, Empty, Alert } from '@/components/ui/kit'

/** docs/92 — every issued foreign invoice still booked at face value, in one list. */
export default async function RebookIndexPage() {
  const ctx = await requireContext()
  const rows = await invoicesNeedingRebook(ctx)

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader back={{ href: '/invoices', label: 'Invoices' }} title="Invoices booked at face value"
        sub="Issued before exchange rates were captured" />

      {rows.length === 0 ? (
        <Card><Empty icon="CheckCircle2" title="Nothing to correct"
          hint="Every foreign-currency invoice that has been issued is booked at an exchange rate." /></Card>
      ) : (
        <>
          <Alert tone="warn" title={`${rows.length} invoice${rows.length === 1 ? '' : 's'} in the ledger at the wrong value`}>
            Each one holds its foreign-currency amount in a rupee account as if it were rupees. Open one,
            enter the rate it should have been booked at, and post the correction.
          </Alert>
          <Card flush className="overflow-hidden">
            {rows.map((r) => (
              <Link key={r.id} href={`/invoices/${r.id}/rebook`}
                className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 first:border-t-0 hover:underline"
                style={{ borderColor: 'var(--rule)' }}>
                <span className="text-[13px] font-semibold">{r.number}</span>
                <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                  {r.customer.name} · {r.date.toISOString().slice(0, 10)}
                </span>
                <span className="tabular text-[13px]">{r.currency} {Number(r.grandTotal).toFixed(2)}</span>
              </Link>
            ))}
          </Card>
        </>
      )}
    </div>
  )
}
