import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { dashboardSummary } from '@/server/services/dashboard'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, StatCard, HeroStat, Pill, Button, Empty, Alert, ProgressBar, DataTable, type Column, statGrid } from '@/components/ui/kit'
import { AreaChart } from '@/components/charts/area-chart'
import { CategoryBars } from '@/components/charts/category-bars'
import { Icon } from '@/components/shell/icon'

export default async function DashboardPage() {
  const ctx = await requireContext()
  const s = await dashboardSummary(ctx)
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true } })

  if (!s) {
    return <Card><Empty title="No open financial year" hint="Create one in Settings before anything can be posted." icon="CalendarX" /></Card>
  }

  const hour = new Date().getUTCHours() + 5.5
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const firstName = user.name.split(' ')[0]

  const recent = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, status: { not: 'DRAFT' } },
    include: { customer: { select: { name: true } } },
    orderBy: [{ date: 'desc' }, { seq: 'desc' }], take: 6,
  })

  const collectionRate = s.invoiced.gt(0) ? s.collected.div(s.invoiced).mul(100).toNumber() : 0
  const hasActivity = s.invoiceCount > 0

  type Row = (typeof recent)[number]
  const cols: Column<Row>[] = [
    { key: 'number', header: 'Invoice', mobile: 'primary',
      cell: (r) => <span className="font-semibold tabular">{r.number}</span> },
    { key: 'customer', header: 'Customer', mobile: 'secondary',
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.customer.name}</span> },
    { key: 'date', header: 'Date', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-muted)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    { key: 'status', header: 'Status', align: 'center', mobile: 'tag',
      cell: (r) => <Pill dot tone={r.status === 'PAID' ? 'good' : r.status === 'PARTIALLY_PAID' ? 'warn' : r.status === 'CANCELLED' ? 'neutral' : 'accent'}>
        {r.status.replace('_', ' ').toLowerCase()}
      </Pill> },
    { key: 'amount', header: 'Amount', align: 'right', mobile: 'value',
      cell: (r) => <span className="font-semibold">{r.currency === 'INR' ? formatINR(r.grandTotal.toString()) : `${r.currency} ${Number(r.grandTotal).toFixed(2)}`}</span> },
  ]

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{greeting}, {firstName}</h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Billing, GST, TDS and cash — FY {s.fy.label} to date.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/invoices/new"><Button icon="Plus">New invoice</Button></Link>
        </div>
      </div>

      {/* ── needs you ──────────────────────────────────────────────────── */}
      {s.alerts.length > 0 && (
        <div className="grid gap-2.5">
          {s.alerts.map((a) => (
            <Alert key={a.id} tone={a.tone} title={a.title}
              action={a.href ? <Link href={a.href}><Button size="sm" variant="ghost">Open</Button></Link> : undefined}>
              {a.detail}
            </Alert>
          ))}
        </div>
      )}

      {/* ── hero + KPIs ────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)]">
        <Card className="flex flex-col justify-between">
          <HeroStat
            label={`Revenue · FY ${s.fy.label}`}
            value={formatINR(s.revenue, { decimals: false })}
            foot={`${s.invoiceCount} invoice${s.invoiceCount === 1 ? '' : 's'} issued · excludes GST`}
          />
          <div className="mt-6 space-y-3">
            <ProgressBar value={s.collected.toNumber()} max={Math.max(s.invoiced.toNumber(), 1)} tone="good"
              label="Collected against invoiced" right={`${collectionRate.toFixed(0)}%`} />
            <div className="flex items-center justify-between text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <span>{s.bank ? `${s.bank.label} ····${s.bank.accountNo.slice(-4)}` : 'No bank account'}</span>
              <span className="tabular">{formatINR(s.collected, { decimals: false })} received</span>
            </div>
          </div>
        </Card>

        <div className={`${statGrid} sm:grid-cols-2`}>
          <StatCard label="Receivable" value={formatINR(s.receivable, { decimals: false })} icon="ArrowDownLeft"
            foot={`${s.openInvoices} open · collectible in cash`} />
          <StatCard label="Overdue" value={String(s.overdueCount)} icon="Clock"
            foot={s.overdueCount ? 'Past the due date' : 'Nothing past due'} tone={s.overdueCount ? 'accent' : 'default'} />
          <StatCard label="TDS receivable" value={formatINR(s.tdsCredited, { decimals: false })} icon="Receipt"
            foot="Credited by clients · reconcile to 26AS" />
          <StatCard label="Output GST" value={formatINR(s.outputGst, { decimals: false })} icon="Percent"
            foot="Collected on sales this year" />
        </div>
      </div>

      {/* ── trend + mix ────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Revenue and collections" sub={`Monthly, FY ${s.fy.label}`} />
          {hasActivity ? (
            <AreaChart
              points={s.series}
              series={[{ name: 'Invoiced (ex-GST)', color: 'var(--series-1)' }, { name: 'Received', color: 'var(--series-3)' }]}
              format="inr-compact"
              caption="Monthly invoiced revenue and cash received"
            />
          ) : (
            <Empty icon="LineChart" title="No postings yet"
              hint="The chart fills in as invoices are sent and receipts recorded. Nothing here is sample data." />
          )}
        </Card>

        <Card>
          <CardHeader title="Revenue by client" sub="Share of invoiced value" />
          <CategoryBars rows={s.byCustomer} format="inr-whole" />
        </Card>
      </div>

      {/* ── ageing + recent ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Receivables ageing" sub="Cash collectible, net of expected TDS" />
          {s.receivable.gt(0) ? (
            <div className="space-y-3.5">
              {(['current', '1-30', '31-60', '61-90', '90+'] as const).map((b) => (
                <ProgressBar key={b} value={s.buckets[b].toNumber()} max={Math.max(s.receivable.toNumber(), 1)}
                  tone={b === 'current' ? 'good' : b === '1-30' ? 'accent' : b === '31-60' ? 'warn' : 'critical'}
                  label={b === 'current' ? 'Not yet due' : `${b} days overdue`}
                  right={formatINR(s.buckets[b], { decimals: false })} />
              ))}
              {s.tdsExpected.gt(0) && (
                <p className="pt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  <Icon name="Info" size={11} strokeWidth={2} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                  {formatINR(s.tdsExpected, { decimals: false })} of TDS is excluded — clients deduct it, so it never arrives as cash.
                </p>
              )}
            </div>
          ) : (
            <Empty icon="CheckCircle2" title="Nothing outstanding" hint="Every issued invoice has been settled." />
          )}
        </Card>

        <Card flush>
          <CardHeader title="Recent invoices" className="p-5 pb-4"
            action={<Link href="/invoices" className="text-[12.5px] font-semibold" style={{ color: 'var(--accent)' }}>See all</Link>} />
          <DataTable columns={cols} rows={recent} keyOf={(r) => r.id} onRowHref={(r) => `/invoices/${r.id}`}
            empty={<Empty icon="FileText" title="No invoices issued yet"
              hint="Your first will be ADP/26-27/0026. The number is allocated by the database when you send it."
              action={<Link href="/invoices/new"><Button>Raise an invoice</Button></Link>} />} />
        </Card>
      </div>
    </div>
  )
}
