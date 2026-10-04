import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { arSummary } from '@/server/services/sales/receivables'
import { Card, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column } from '@/components/ui/kit'
import { CancelReceiptButton } from './cancel-button'
import { AdjustAdvance } from './adjust-advance'
import { RefundAdvance } from './refund-advance'
import { openAdvances } from '@/server/services/sales/advance'
import { listRefundVouchers } from '@/server/services/sales/refund'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelRefundVoucherAction } from './actions'

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

  // docs/54 — advances with something left to absorb, and the invoices that could absorb them
  const advances = await openAdvances(ctx)
  // docs/69 — the vouchers had no list at all; `listRefundVouchers` had tests and no caller
  const vouchers = await listRefundVouchers(ctx)
  const openInvoices = advances.length === 0 ? [] : await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] },
      customerId: { in: [...new Set(receipts.filter((r) => r.isAdvance).map((r) => r.customerId))] },
    },
    select: { id: true, number: true, customerId: true, grandTotal: true, amountReceived: true, tdsCredited: true },
    orderBy: { date: 'asc' },
  })

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
            {r.allocations.map((a) => a.invoice.number).join(', ')
              || (r.isAdvance ? 'advance — no invoice yet' : 'unallocated')}
          </span>
        </>
      ) },
    { key: 'date', header: 'Date', width: '12%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    { key: 'mode', header: 'Mode', width: '11%', align: 'center', mobile: 'tag',
      cell: (r) => r.isAdvance
        ? <Pill tone="accent">advance</Pill>
        : <Pill tone="neutral">{r.mode}</Pill> },
    { key: 'tds', header: 'TDS withheld', width: '14%', align: 'right', mobile: false,
      cell: (r) => new Decimal(r.tdsAmount.toString()).gt(0)
        ? <span className="tabular">{formatINR(r.tdsAmount.toString())}</span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'cancel', header: '', width: '16%', align: 'right', mobile: 'action',
      cell: (r) => {
        if (r.cancelledAt) return <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>reversed</span>
        const adv = advances.find((a) => a.id === r.id)
        if (adv) {
          return (
            // 🔴 a gap. Side by side with none, the two links read as one word — "adjustrefund it"
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <AdjustAdvance receiptId={r.id} open={adv.open.toFixed(2)}
              invoices={openInvoices
                .filter((i) => i.customerId === r.customerId)
                .map((i) => ({
                  id: i.id, number: i.number,
                  outstanding: new Decimal(i.grandTotal.toString())
                    .minus(i.amountReceived.toString()).minus(i.tdsCredited.toString()),
                }))
                // 🔴 An invoice with nothing open cannot absorb anything — the service refuses
                // it, so offering it is offering a button that can only fail. Status alone is
                // not enough: an invoice settled by a receipt may still read PARTIALLY_PAID.
                .filter((i) => i.outstanding.gt('0.5'))
                .map((i) => ({ id: i.id, number: i.number, outstanding: formatINR(i.outstanding) }))} />
            <RefundAdvance receiptId={r.id} open={adv.open.toFixed(2)} />
            </span>
          )
        }
        return <CancelReceiptButton receiptId={r.id} number={r.number} />
      } },
    { key: 'amount', header: 'Received', width: '15%', align: 'right', mobile: 'value',
      cell: (r) => <span className="font-semibold tabular"
        style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
        {formatINR(r.amount.toString())}
      </span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Receipts" sub="Money actually received, and the TDS clients withheld on the way."
        action={
          <>
            <Link href="/receipts/advance"><Button variant="ghost">Advance received</Button></Link>
            <Link href="/receipts/new"><Button>Record a receipt</Button></Link>
          </>
        } />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Collected" value={formatINR(collected, { decimals: false })}
          foot={`${live.length} receipt${live.length === 1 ? '' : 's'}${receipts.length !== live.length ? ` · ${receipts.length - live.length} cancelled` : ''}`} />
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

      {vouchers.length > 0 && <RefundRegister vouchers={vouchers} />}

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

/**
 * Refund vouchers — docs/69.
 *
 * 🔴 Here rather than with the credit notes, because this is where somebody looks for them: a
 * refund voucher refunds a RECEIPT. s.31(3)(e) gives it its own document precisely because
 * there is no invoice to credit, and filing it beside the notes would repeat the mistake the
 * document exists to prevent.
 */
function RefundRegister({ vouchers }: { vouchers: Awaited<ReturnType<typeof listRefundVouchers>> }) {
  const live = vouchers.filter((v) => !v.cancelledAt)
  const total = live.reduce((a, v) => a.plus(v.amount.toString()), ZERO as Decimal)
  const taxBack = live.reduce((a, v) => a.plus(v.cgst.toString()).plus(v.sgst.toString()).plus(v.igst.toString()), ZERO as Decimal)

  type V = (typeof vouchers)[number]
  const cols: Column<V>[] = [
    { key: 'num', header: 'Voucher', width: '16%', mobile: 'primary',
      cell: (v) => (
        <span className="flex items-center gap-2">
          <span className="font-semibold tabular"
            style={v.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            {v.number}
          </span>
          {v.cancelledAt && <Pill tone="neutral">cancelled</Pill>}
        </span>
      ) },
    { key: 'against', header: 'Against', width: '22%', mobile: 'secondary',
      cell: (v) => (
        <>
          {/* rule 51 — the document carries the receipt voucher's number and date on its face */}
          <span className="block tabular">{v.receipt.number}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{v.customer.name}</span>
        </>
      ) },
    { key: 'date', header: 'Date', width: '12%', mobile: false,
      cell: (v) => <span style={{ color: 'var(--text-secondary)' }}>{v.date.toISOString().slice(0, 10)}</span> },
    { key: 'reason', header: 'Reason', width: '24%', mobile: false,
      cell: (v) => <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{v.reason}</span> },
    { key: 'tax', header: 'GST back', width: '13%', align: 'right', mobile: 'tag',
      cell: (v) => {
        const t = new Decimal(v.cgst.toString()).plus(v.sgst.toString()).plus(v.igst.toString())
        return t.isZero()
          ? <span style={{ color: 'var(--text-muted)' }}>none</span>
          : <span className="tabular">{formatINR(t)}</span>
      } },
    { key: 'amount', header: 'Refunded', width: '14%', align: 'right', mobile: 'value',
      cell: (v) => <span className="font-semibold tabular"
        style={v.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
        {formatINR(v.amount.toString())}
      </span> },
    { key: 'cancel', header: '', width: '12%', align: 'right', mobile: 'action',
      cell: (v) => v.cancelledAt
        ? <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>reversed</span>
        : <ReverseButton action={cancelRefundVoucherAction} idName="voucherId" id={v.id}
            prompt={`Why is ${v.number} being reversed?`} /> },
  ]

  return (
    <Card flush className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3"
           style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
        <span className="eyebrow">Refund vouchers · s.31(3)(e)</span>
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {formatINR(total, { decimals: false })} returned
          {taxBack.gt(0) && <> · {formatINR(taxBack, { decimals: false })} of it tax declared when it arrived</>}
        </span>
      </div>
      <DataTable columns={cols} rows={vouchers} keyOf={(v) => v.id} noun="vouchers" />
      <p className="px-4 py-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        An advance returned without a supply is not a credit note — there is no invoice to credit. The tax
        declared on it under s.13(2) comes back as an adjustment of advances in GSTR-1 table 11B, and
        cancelling a voucher is refused once that return is filed.
      </p>
    </Card>
  )
}
