import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { arSummary } from '@/server/services/sales/receivables'
import { formatINR } from '@/lib/money'
import { peekNextNumber } from '@/server/services/invoicing/numbering'
import { Card, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column } from '@/components/ui/kit'
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
  searchParams: Promise<{ page?: string }>
}) {
  const ctx = await requireContext()
  const sp = await searchParams
  const where = { companyId: ctx.companyId }

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
      : { kind: 'link', label: 'PDF', legend: 'for the invoice PDF', icon: 'Download', tone: 'info', href: `/api/invoices/${r.id}/document` }
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

  return (
    <div>
      <PageHeader title="Invoices" sub={fy ? `FY ${fy.label} · ${page.total} on record` : undefined}
        action={<Link href="/invoices/new"><Button icon="Plus">New invoice</Button></Link>} />

      {page.total > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Collectible" value={formatINR(ar.total, { decimals: false })} icon="Wallet" foot={`${ar.invoiceCount} open`} />
          <StatCard label="Overdue" value={String(ar.overdueCount)} icon="Clock" foot={ar.overdueCount ? 'Needs follow-up' : 'All current'} />
          <StatCard label="TDS expected" value={formatINR(ar.tdsExpected, { decimals: false })} icon="Receipt" foot="Never arrives as cash" />
          <StatCard label="Next number" value={nextNumber ?? '—'} icon="Hash" foot="Allocated on send" />
        </div>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={invoices} keyOf={(r) => r.id} onRowHref={(r) => `/invoices/${r.id}`}
          swipe={swipe} noun="invoices"
          empty={<Empty icon="FileText" title="No invoices yet"
            hint={nextNumber ? `Your first will be ${nextNumber}. The number is allocated by the database when you send it, so an abandoned draft never leaves a gap in the series.` : undefined}
            action={<Link href="/invoices/new"><Button>Raise the first invoice</Button></Link>} />} />
        <Pager page={page} basePath="/invoices" params={sp} noun="invoices" />
      </Card>
    </div>
  )
}
