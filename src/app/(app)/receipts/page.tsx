import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { arSummary } from '@/server/services/sales/receivables'
import { Card, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column } from '@/components/ui/kit'
import { CancelReceiptButton } from './cancel-button'

export default async function ReceiptsPage() {
  const ctx = await requireContext()

  const [receipts, ar] = await Promise.all([
    prisma.receipt.findMany({
      where: { companyId: ctx.companyId },
      include: {
        customer: { select: { name: true } },
        allocations: { include: { invoice: { select: { id: true, number: true } } } },
      },
      orderBy: [{ date: 'desc' }], take: 100,
    }),
    arSummary(ctx).catch(() => null),
  ])

  // 🔴 Cancelled receipts stay in the LIST — the number was allocated and the reversal is
  // part of the record — but they must not count towards anything collected.
  const live = receipts.filter((r) => !r.cancelledAt)
  const collected = live.reduce((a, r) => a.plus(r.amount.toString()), ZERO)
  const tdsOnReceipts = live.reduce((a, r) => a.plus(r.tdsAmount.toString()), ZERO)

  type Row = (typeof receipts)[number]
  const cols: Column<Row>[] = [
    { key: 'num', header: 'Receipt', width: '15%', mobile: 'primary',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-semibold tabular" style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            {r.number}
          </span>
          {r.cancelledAt && <Pill tone="neutral">cancelled</Pill>}
        </span>
      ) },
    { key: 'customer', header: 'From', mobile: 'secondary',
      cell: (r) => (
        <>
          <span className="block">{r.customer.name}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.allocations.map((a) => a.invoice.number).join(', ') || 'unallocated'}
          </span>
        </>
      ) },
    { key: 'date', header: 'Date', width: '12%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    { key: 'mode', header: 'Mode', width: '11%', align: 'center', mobile: 'tag',
      cell: (r) => <Pill tone="neutral">{r.mode}</Pill> },
    { key: 'tds', header: 'TDS withheld', width: '14%', align: 'right', mobile: false,
      cell: (r) => new Decimal(r.tdsAmount.toString()).gt(0)
        ? <span className="tabular">{formatINR(r.tdsAmount.toString())}</span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'cancel', header: '', width: '12%', align: 'right', mobile: false,
      cell: (r) => r.cancelledAt
        ? <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>reversed</span>
        : <CancelReceiptButton receiptId={r.id} number={r.number} /> },
    { key: 'amount', header: 'Received', width: '15%', align: 'right', mobile: 'value',
      cell: (r) => <span className="font-semibold tabular"
        style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
        {formatINR(r.amount.toString())}
      </span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Receipts" sub="Money actually received, and the TDS clients withheld on the way."
        action={<Link href="/receipts/new"><Button>Record a receipt</Button></Link>} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Collected" value={formatINR(collected, { decimals: false })}
          foot={`${live.length} receipts${receipts.length !== live.length ? ` · ${receipts.length - live.length} cancelled` : ''}`} />
        <StatCard label="TDS withheld by clients" value={formatINR(tdsOnReceipts, { decimals: false })}
          foot="claimable only once it reaches Form 26AS" />
        <StatCard label="Still outstanding" value={ar ? formatINR(ar.total, { decimals: false }) : '—'}
          foot={ar ? `${ar.invoiceCount} open invoices` : undefined} tone="accent" />
      </div>

      {receipts.length === 0 ? (
        <Card><Empty icon="Receipt" title="No receipts yet"
          hint="A receipt is created when an invoice is settled — by hand, or from a matched bank line on the reconcile screen. Nothing here is sample data."
          action={<Link href="/receipts/new"><Button>Record a receipt</Button></Link>} /></Card>
      ) : (
        <Card flush className="overflow-hidden">
          {/* no row link: the row carries its own cancel control, and a link wrapping the
              whole row would swallow the click */}
          <DataTable columns={cols} rows={receipts} keyOf={(r) => r.id} />
        </Card>
      )}

      <Card className="p-4">
        <p className="eyebrow">Where receipts come from</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Most are booked automatically from the bank statement on{' '}
          <Link href="/banking/reconcile" className="underline">reconcile</Link> — the matcher
          recognises a credit that is short by exactly the TDS and settles the invoice in full.
          A receipt booked that way is identical to one keyed by hand.
        </p>
      </Card>
    </div>
  )
}
