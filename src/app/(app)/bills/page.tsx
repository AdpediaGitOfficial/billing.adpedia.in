import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { apSummary, tdsPayableSummary } from '@/server/services/purchases/payables'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, StatCard, Pill, Empty, Button, DataTable, type Column, type Tone } from '@/components/ui/kit'
import type { BillStatus } from '@prisma/client'

const TONE: Record<BillStatus, Tone> = {
  DRAFT: 'neutral', APPROVED: 'accent', PARTIALLY_PAID: 'warn', PAID: 'good', CANCELLED: 'neutral',
}

export default async function BillsPage() {
  const ctx = await requireContext()
  const [bills, ap, tds] = await Promise.all([
    prisma.vendorBill.findMany({
      where: { companyId: ctx.companyId },
      include: { vendor: { select: { name: true } }, project: { select: { name: true } } },
      orderBy: [{ billDate: 'desc' }], take: 100,
    }),
    apSummary(ctx),
    tdsPayableSummary(ctx),
  ])

  type Row = (typeof bills)[number]
  const cols: Column<Row>[] = [
    { key: 'num', header: 'Bill', width: '16%', mobile: 'primary',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-semibold tabular">{r.billNumber}</span>
          {r.isRcm && <Pill tone="warn">RCM</Pill>}
        </span>
      ) },
    { key: 'vendor', header: 'Vendor', mobile: 'secondary',
      cell: (r) => (
        <>
          <span className="block">{r.vendor.name}</span>
          {r.project && <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.project.name}</span>}
        </>
      ) },
    { key: 'date', header: 'Date', width: '11%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.billDate.toISOString().slice(0, 10)}</span> },
    { key: 'tds', header: 'TDS', width: '12%', align: 'right', mobile: false,
      cell: (r) => Number(r.tdsAmount) > 0
        ? <><span className="block tabular">{formatINR(r.tdsAmount.toString())}</span>
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.tdsSection}</span></>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'status', header: 'Status', width: '13%', align: 'center', mobile: 'tag',
      cell: (r) => <Pill dot tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'amount', header: 'Amount', width: '15%', align: 'right', mobile: 'value',
      cell: (r) => (
        <>
          <span className="block font-semibold">{formatINR(r.grandTotal.toString())}</span>
          {Number(r.tdsAmount) > 0 && (
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
              pay {formatINR(Number(r.grandTotal) - Number(r.tdsAmount), { decimals: false })}
            </span>
          )}
        </>
      ) },
  ]

  return (
    <div>
      <PageHeader title="Vendor bills" sub={`${bills.length} on record`}
        action={<Link href="/bills/new"><Button icon="Plus">New bill</Button></Link>} />

      {bills.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Payable" value={formatINR(ap.total, { decimals: false })} icon="ArrowUpRight" foot={`${ap.billCount} open · net of TDS`} />
          <StatCard label="Due this week" value={formatINR(ap.dueThisWeek, { decimals: false })} icon="CalendarClock" foot={ap.overdueCount ? `${ap.overdueCount} already overdue` : 'Nothing overdue'} />
          <StatCard label="TDS to deposit" value={formatINR(tds.total, { decimals: false })} icon="Landmark"
            foot={tds.bySection.map((s) => `${s.section} ${formatINR(s.amount, { decimals: false })}`).join(' · ') || 'Nothing withheld'} />
          <StatCard label="Reverse charge" value={String(bills.filter((b) => b.isRcm).length)} icon="RefreshCw" foot="Self-invoiced imports" />
        </div>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={bills} keyOf={(r) => r.id} onRowHref={(r) => `/bills/${r.id}`}
          empty={<Empty icon="FileInput" title="No vendor bills yet"
            hint="TDS is computed at entry — including the retrospective catch-up when a vendor crosses the annual threshold."
            action={<Link href="/bills/new"><Button>Enter the first bill</Button></Link>} />} />
      </Card>
    </div>
  )
}
