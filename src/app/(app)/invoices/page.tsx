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

const TONE: Record<InvoiceStatus, Tone> = {
  DRAFT: 'neutral', SENT: 'accent', VIEWED: 'accent',
  PARTIALLY_PAID: 'warn', PAID: 'good', OVERDUE: 'critical', CANCELLED: 'neutral',
}

export default async function InvoicesPage() {
  const ctx = await requireContext()
  const [invoices, ar, fy] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId: ctx.companyId },
      include: { customer: { select: { name: true } }, project: { select: { name: true } } },
      orderBy: [{ date: 'desc' }, { seq: 'desc' }], take: 100,
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

  return (
    <div>
      <PageHeader title="Invoices" sub={fy ? `FY ${fy.label} · ${invoices.length} on record` : undefined}
        action={<Link href="/invoices/new"><Button icon="Plus">New invoice</Button></Link>} />

      {invoices.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Collectible" value={formatINR(ar.total, { decimals: false })} icon="Wallet" foot={`${ar.invoiceCount} open`} />
          <StatCard label="Overdue" value={String(ar.overdueCount)} icon="Clock" foot={ar.overdueCount ? 'Needs follow-up' : 'All current'} />
          <StatCard label="TDS expected" value={formatINR(ar.tdsExpected, { decimals: false })} icon="Receipt" foot="Never arrives as cash" />
          <StatCard label="Next number" value={nextNumber ?? '—'} icon="Hash" foot="Allocated on send" />
        </div>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={invoices} keyOf={(r) => r.id} onRowHref={(r) => `/invoices/${r.id}`}
          empty={<Empty icon="FileText" title="No invoices yet"
            hint={nextNumber ? `Your first will be ${nextNumber}. The number is allocated by the database when you send it, so an abandoned draft never leaves a gap in the series.` : undefined}
            action={<Link href="/invoices/new"><Button>Raise the first invoice</Button></Link>} />} />
      </Card>
    </div>
  )
}
