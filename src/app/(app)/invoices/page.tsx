import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { arSummary } from '@/server/services/sales/receivables'
import { invoicesByMonth, monthBounds, monthLabel } from '@/server/services/sales/invoice-months'
import { formatINR } from '@/lib/money'
import { peekNextNumber } from '@/server/services/invoicing/numbering'
import { Card, CardHeader, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column, statGrid, tapTarget } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'
import type { InvoiceStatus } from '@prisma/client'
import type { Tone } from '@/components/ui/kit'
import { currentFinancialYear } from '@/server/services/accounting/period'
import { paginate } from '@/lib/paging'
import { Pager } from '@/components/ui/pager'
import { can } from '@/server/auth/permissions'
import type { SwipeSpec } from '@/components/ui/swipe'
import { sendInvoiceAction } from './actions'

const TONE: Record<InvoiceStatus, Tone> = {
  DRAFT: 'neutral', SENT: 'accent', VIEWED: 'accent',
  PARTIALLY_PAID: 'warn', PAID: 'good', OVERDUE: 'critical', CANCELLED: 'neutral',
}

export default async function InvoicesPage({ searchParams }: {
  searchParams: Promise<{ page?: string; month?: string; view?: string }>
}) {
  const ctx = await requireContext()
  const sp = await searchParams

  /**
   * 🔴 docs/83 §7 — the month filter is VALIDATED, not interpolated.
   *
   * `monthBounds` returns null for anything that is not `YYYY-MM` with a real month, and a
   * null month means no filter rather than an error page: `?month=` is a hand-edited URL, a
   * stale bookmark or a truncated share, and the honest answer to one is the whole list, the
   * same argument `paginate` makes for `?page=99`.
   */
  const month = sp.month && monthBounds(sp.month) ? sp.month : undefined
  const bounds = month ? monthBounds(month)! : null
  const where = {
    companyId: ctx.companyId,
    ...(bounds ? { date: { gte: bounds.from, lt: bounds.to } } : {}),
  }

  /**
   * 🔴 docs/78 — the stats are over EVERYTHING, the list is over a page.
   *
   * `arSummary` reads its own query across every open invoice, so "Collectible" stays the
   * company's position rather than this page's. A paginated list whose tiles paginate with it
   * is a figure that changes when somebody clicks Next, which is the fastest way to make a
   * dashboard untrustworthy.
   */
  const page = paginate(await prisma.invoice.count({ where }), sp.page)

  const [invoices, ar, fy] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { customer: { select: { name: true } }, project: { select: { name: true } } },
      /**
       * 🔴 `id` last, and it is not decoration — docs/58 §4's lesson in a new place.
       *
       * This ordered by `date desc, seq desc`, and every DRAFT has `seq: 0`. Fifty drafts on
       * one date have no order at all between them, so Postgres is free to return them
       * differently for page 1 and page 2 — the same invoice twice, another never. Unpaginated
       * it only looked untidy; paginated it loses rows.
       */
      orderBy: [{ date: 'desc' }, { seq: 'desc' }, { id: 'desc' }],
      skip: page.skip, take: page.take,
    }),
    arSummary(ctx),
    currentFinancialYear(ctx.companyId),
  ])

  // docs/83 §7 — the months of the year this company is in, including the empty ones
  const months = fy ? await invoicesByMonth(ctx, fy.label) : []
  const byMonth = sp.view === 'months'

  const nextNumber = fy
    ? await peekNextNumber(prisma, { companyId: ctx.companyId, financialYearId: fy.id, docType: 'TAX_INVOICE', fyLabel: fy.label })
    : null

  type Row = (typeof invoices)[number]
  const cols: Column<Row>[] = [
    { key: 'number', header: 'Invoice', width: '18%', mobile: 'primary',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-semibold tabular">{r.status === 'DRAFT' ? 'Draft' : r.number}</span>
          {r.taxMode === 'EXPORT' && <Pill tone="warn">Export</Pill>}
        </span>
      ) },
    { key: 'customer', header: 'Customer', mobile: 'secondary',
      cell: (r) => (
        <>
          <span className="block">{r.customer.name}</span>
          {r.project && <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.project.name}</span>}
        </>
      ) },
    { key: 'date', header: 'Date', width: '12%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    { key: 'due', header: 'Due', width: '12%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-muted)' }}>{r.dueDate.toISOString().slice(0, 10)}</span> },
    { key: 'status', header: 'Status', width: '14%', align: 'center', mobile: 'tag',
      cell: (r) => <Pill dot tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'amount', header: 'Amount', width: '16%', align: 'right', mobile: 'value',
      cell: (r) => (
        <>
          <span className="block font-semibold">
            {r.currency === 'INR' ? formatINR(r.grandTotal.toString()) : `${r.currency} ${Number(r.grandTotal).toFixed(2)}`}
          </span>
          {Number(r.tdsAmount) > 0 && (
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
              net {formatINR(r.netPayable.toString(), { decimals: false })}
            </span>
          )}
        </>
      ) },
    /**
     * 🔴 docs/83 §6 — the file, from the list.
     *
     * The PDF was reachable three ways and none of them said "download": the detail page's
     * *View document*, which opens a preview; a swipe-left on the mobile card, which is a
     * gesture and opens a preview; and nothing at all in the desktop table. Getting the file
     * out of a list of five invoices meant opening five pages.
     *
     * `mobile: 'action'` rather than `false`, because `false` on a column holding a control
     * is what docs/68 §5 found twice — the control simply does not exist on a phone. The
     * anchor sits in its own column so the row-wide link does not swallow it.
     *
     * A DRAFT has no document to download: it has not been issued, its number is a
     * placeholder, and the archive is written at issue. The cell says so rather than offering
     * a link that renders `DRAFT.pdf`.
     */
    { key: 'pdf', header: '', width: '8%', align: 'right', mobile: 'action',
      cell: (r) => r.status === 'DRAFT'
        ? <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>not issued</span>
        : (
          <a href={`/api/invoices/${r.id}/document?download=1`}
            download={`${r.number.replace(/\//g, '-')}.pdf`}
            className={`gap-1 text-[12px] font-semibold transition-colors hover:underline ${tapTarget}`}
            style={{ color: 'var(--accent)' }} title={`Download ${r.number} as a PDF`}>
            <Icon name="Download" size={13} strokeWidth={2} /> PDF
          </a>
        ) },
  ]

  /**
   * docs/68 §3 — the mobile card's swipe actions, decided per row because what an invoice
   * needs next is its status. Nothing here posts on the gesture: `Send` is held behind the
   * Undo window, and the other two are links.
   *
   * 🔴 Cancelling is not offered. s.31 requires a reason and docs/40 records it — an action
   * that needs words cannot be a gesture, and prompting for them inside the Undo window
   * would mean the row said "cancelling" before anyone had said why.
   */
  const maySend = can(ctx.role, 'invoices.send', 'approve')
  const mayReceipt = can(ctx.role, 'receipts', 'write')
  const swipe = (r: Row): SwipeSpec | undefined => {
    if (r.status === 'CANCELLED') return undefined
    const pdf: SwipeSpec['left'] = r.status === 'DRAFT' ? undefined
      // 🔴 docs/83 §6 — the gesture is labelled Download and now sends `attachment`; it was
      // opening a preview, which is a different thing from what the icon promised
      : { kind: 'link', label: 'PDF', legend: 'for the invoice PDF', icon: 'Download', tone: 'info', href: `/api/invoices/${r.id}/document?download=1` }
    if (r.status === 'DRAFT') {
      return {
        right: maySend
          ? { kind: 'commit', label: 'Send', legend: 'to send it', icon: 'Send', tone: 'accent',
              done: `Sending to ${r.customer.name}`, run: sendInvoiceAction.bind(null, r.id) }
          : undefined,
        // docs/70 — the draft is editable now, so the gesture has somewhere useful to go
        left: { kind: 'link', label: 'Edit', legend: 'to edit the draft', icon: 'Pencil',
          tone: 'info', href: `/invoices/${r.id}/edit` },
      }
    }
    if (r.status === 'PAID') return { left: pdf }
    return {
      right: mayReceipt
        ? { kind: 'link', label: 'Receipt', legend: 'to record a receipt', icon: 'HandCoins', tone: 'good', href: `/receipts/new?invoice=${r.id}` }
        : undefined,
      left: pdf,
    }
  }

  /**
   * The month table — docs/83 §7.
   *
   * 🔴 Cancelled and draft counts sit beside the money rather than inside it. A cancelled
   * invoice keeps its number (docs/41) and has been reversed, so adding its value to a month
   * overstates what was billed; a draft has taken no number and posted nothing. Both still
   * belong on the row, because "nine issued, one cancelled" is a different month from "nine
   * issued" and an admin is entitled to see which.
   */
  type MonthRow = (typeof months)[number]
  const monthCols: Column<MonthRow>[] = [
    { key: 'month', header: 'Month', width: '18%', mobile: 'primary',
      cell: (m) => (
        <span className="flex items-center gap-2">
          <span className="font-semibold">{m.label}</span>
          {m.current && <Pill tone="accent">this month</Pill>}
        </span>
      ) },
    { key: 'issued', header: 'Issued', width: '10%', align: 'right', mobile: 'secondary',
      cell: (m) => m.issued === 0 && m.drafts === 0 && m.cancelled === 0
        ? <span style={{ color: 'var(--text-muted)' }}>nothing billed</span>
        : (
          <span>
            <span className="tabular font-semibold">{m.issued}</span>
            {m.cancelled > 0 && <span className="ml-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{m.cancelled} cancelled</span>}
            {m.drafts > 0 && <span className="ml-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{m.drafts} draft</span>}
          </span>
        ) },
    { key: 'taxable', header: 'Taxable', width: '16%', align: 'right', mobile: false,
      cell: (m) => <span>{m.issued ? formatINR(m.taxableValue) : '—'}</span> },
    { key: 'gst', header: 'GST', width: '14%', align: 'right', mobile: false,
      cell: (m) => <span>{m.issued ? formatINR(m.gst) : '—'}</span> },
    { key: 'total', header: 'Invoiced', width: '16%', align: 'right', mobile: 'value',
      cell: (m) => (
        <>
          <span className="block font-semibold">{m.issued ? formatINR(m.grandTotal) : '—'}</span>
          {/* 🔴 named, not converted — `Invoice.fxRate` is read nowhere, so there is no rate
              to convert at and a USD total added to a rupee column would be wrong by two
              orders of magnitude while looking like a number */}
          {m.foreignCurrency.map((f) => (
            <span key={f.currency} className="block text-[11px]" style={{ color: 'var(--warn)' }}>
              + {f.count} in {f.currency}
            </span>
          ))}
        </>
      ) },
    { key: 'outstanding', header: 'Outstanding', width: '16%', align: 'right', mobile: 'tag',
      cell: (m) => m.outstanding.gt(0)
        ? <Pill tone="warn">{formatINR(m.outstanding, { decimals: false })} due</Pill>
        : m.issued > 0 ? <Pill tone="good">settled</Pill> : <span style={{ color: 'var(--text-muted)' }}>—</span> },
  ]

  const tab = (label: string, href: string, on: boolean) => (
    <Link href={href}
      className={`rounded-lg px-3 text-[12.5px] font-semibold transition-colors ${tapTarget}`}
      style={on
        ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' }
        : { color: 'var(--text-secondary)' }}>
      {label}
    </Link>
  )

  return (
    <div>
      <PageHeader title="Invoices"
        sub={month
          ? `${monthLabel(month)} · ${page.total} ${page.total === 1 ? 'invoice' : 'invoices'}`
          : fy ? `FY ${fy.label} · ${page.total} on record` : undefined}
        action={<Link href="/invoices/new"><Button icon="Plus">New invoice</Button></Link>} />

      {/* 🔴 docs/83 §7 — two views of the same year, and the URL says which. Links rather
          than a `Segmented`, because this is navigation: it has to survive a bookmark, a
          share and the back button, which a piece of client state does not. */}
      {fy && (
        <div className="mb-4 flex flex-wrap items-center gap-1">
          {tab('Invoices', month ? `/invoices?month=${month}` : '/invoices', !byMonth)}
          {tab('By month', '/invoices?view=months', byMonth)}
          {month && !byMonth && (
            <Link href="/invoices"
              className={`ml-1 gap-1 px-2 text-[12px] transition-colors hover:underline ${tapTarget}`}
              style={{ color: 'var(--text-muted)' }}>
              <Icon name="CalendarX" size={13} strokeWidth={2} /> Clear {monthLabel(month)}
            </Link>
          )}
        </div>
      )}

      {/* 🔴 docs/83 §7 — not on the month view. These four answer a receivables question and
          the month table answers a billing one; stacking them above it costs a phone its whole
          first screen before the first month, which is the mistake §5.3 just undid for the
          list. The month table carries its own money. */}
      {page.total > 0 && !byMonth && (
        /**
         * 🔴 docs/83 §7 — these stay the COMPANY's position and now say so.
         *
         * docs/78's argument is that tiles must not paginate with the list, and it holds. A
         * month filter is not Next, though — it is somebody asking about October — so beside
         * a header reading "Oct 2026 · 3 invoices" a bare "₹8,21,000 · 5 open" reads as
         * October's. It is the year's. The tiles are about receivables, which do not belong
         * to the month an invoice was raised in, so the figures do not change; the label does.
         */
        <div className={`${statGrid} mb-5 sm:grid-cols-2 lg:grid-cols-4`}>
          <StatCard label="Collectible" value={formatINR(ar.total, { decimals: false })} icon="Wallet"
            foot={month ? `${ar.invoiceCount} open · whole year` : `${ar.invoiceCount} open`} />
          <StatCard label="Overdue" value={String(ar.overdueCount)} icon="Clock"
            foot={ar.overdueCount ? (month ? 'Needs follow-up · whole year' : 'Needs follow-up') : 'All current'} />
          <StatCard label="TDS expected" value={formatINR(ar.tdsExpected, { decimals: false })} icon="Receipt"
            foot={month ? 'Never arrives as cash · whole year' : 'Never arrives as cash'} />
          <StatCard label="Next number" value={nextNumber ?? '—'} icon="Hash" foot="Allocated on send" />
        </div>
      )}

      {byMonth ? (
        <Card flush className="overflow-hidden">
          <CardHeader title={`FY ${fy?.label ?? ''} month by month`} className="p-5 pb-3"
            sub="Every month of the year, including the ones with nothing in them — a month that is missing from a list cannot be asked about. Pick one to see its invoices." />
          <DataTable columns={monthCols} rows={months} keyOf={(m) => m.key}
            onRowHref={(m) => `/invoices?month=${m.key}`} noun="months"
            empty={<Empty icon="Calendar" title="No financial year is open"
              hint="A document series and its months both hang off the financial year." />} />
        </Card>
      ) : (
      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={invoices} keyOf={(r) => r.id} onRowHref={(r) => `/invoices/${r.id}`}
          swipe={swipe} noun="invoices"
          empty={<Empty icon="FileText" title="No invoices yet"
            hint={nextNumber ? `Your first will be ${nextNumber}. The number is allocated by the database when you send it, so an abandoned draft never leaves a gap in the series.` : undefined}
            action={<Link href="/invoices/new"><Button>Raise the first invoice</Button></Link>} />} />
        <Pager page={page} basePath="/invoices" params={sp} noun="invoices" />
      </Card>
      )}
    </div>
  )
}
