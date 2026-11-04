import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { arSummary } from '@/server/services/sales/receivables'
import { Card, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column, statGrid } from '@/components/ui/kit'
import { CancelReceiptButton } from './cancel-button'
import { AdjustAdvance } from './adjust-advance'
import { RefundAdvance } from './refund-advance'
import { openAdvances } from '@/server/services/sales/advance'
import { listRefundVouchers } from '@/server/services/sales/refund'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelRefundVoucherAction } from './actions'
import { paginate } from '@/lib/paging'
import { Pager } from '@/components/ui/pager'

export default async function ReceiptsPage({ searchParams }: {
  searchParams: Promise<{ page?: string }>
}) {
  const ctx = await requireContext()
  const sp = await searchParams
  const where = { companyId: ctx.companyId }
  const page = paginate(await prisma.receipt.count({ where }), sp.page)

  const [receipts, ar] = await Promise.all([
    prisma.receipt.findMany({
      where,
      include: {
        customer: { select: { name: true } },
        allocations: { include: { invoice: { select: { id: true, number: true } } } },
      },
      // 🔴 `date` alone is not an order — docs/58 §4, and under pagination it loses rows
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: page.skip, take: page.take,
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
      /**
       * 🔴 The customers of every OPEN ADVANCE, not of the advances on this page.
       *
       * It read `receipts.filter(isAdvance)`, which was every advance while the list was
       * everything. Paginated, an advance on page 2 would have found no invoices offered
       * against it — an "adjust" control that opens on an empty list, for no visible reason.
       */
      customerId: { in: [...new Set(advances.map((a) => a.customerId))] },
    },
    select: { id: true, number: true, customerId: true, grandTotal: true, amountReceived: true, tdsCredited: true },
    orderBy: { date: 'asc' },
  })

  /**
   * 🔴 Cancelled receipts stay in the LIST — the number was allocated and the reversal is part
   * of the record — but they must not count towards anything collected.
   *
   * 🔴 And these are aggregated by the DATABASE, over every receipt, not reduced over the fifty
   * on screen. `live.reduce(...)` was correct while the list was everything; paginating it
   * would have turned "Collected" into "collected on this page", and the figure would have
   * changed every time somebody pressed Next — docs/78.
   */
  const [liveCount, cancelledCount, totals] = await Promise.all([
    prisma.receipt.count({ where: { ...where, cancelledAt: null } }),
    prisma.receipt.count({ where: { ...where, cancelledAt: { not: null } } }),
    prisma.receipt.aggregate({
      where: { ...where, cancelledAt: null },
      _sum: { amount: true, tdsAmount: true },
    }),
  ])
  const collected = new Decimal(totals._sum.amount?.toString() ?? '0')
  const tdsOnReceipts = new Decimal(totals._sum.tdsAmount?.toString() ?? '0')

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

      <div className={`${statGrid} sm:grid-cols-3`}>
        <StatCard label="Collected" value={formatINR(collected, { decimals: false })}
          foot={`${liveCount} receipt${liveCount === 1 ? '' : 's'}${cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ''}`} />
        <StatCard label="TDS withheld by clients" value={formatINR(tdsOnReceipts, { decimals: false })}
          foot="claimable only once it reaches Form 26AS" />
        <StatCard label="Still outstanding" value={ar ? formatINR(ar.total, { decimals: false }) : '—'}
          foot={ar ? `${ar.invoiceCount} open invoices` : undefined} tone="accent" />
      </div>

      {page.total === 0 ? (
        <Card><Empty icon="Receipt" title="No receipts yet"
          hint="A receipt is created when an invoice is settled — by hand, or from a matched bank line on the reconcile screen. Nothing here is sample data."
          action={<Link href="/receipts/new"><Button>Record a receipt</Button></Link>} /></Card>
      ) : (
        <Card flush className="overflow-hidden">
          {/* no row link: the row carries its own cancel control, and a link wrapping the
              whole row would swallow the click */}
          <DataTable columns={cols} rows={receipts} keyOf={(r) => r.id} noun="receipts" />
          <Pager page={page} basePath="/receipts" params={sp} noun="receipts" />
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
