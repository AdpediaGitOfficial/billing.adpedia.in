import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { receivableSummary, form16aChaseList } from '@/server/services/tax/tds-receivable'
import { reconcile26as } from '@/server/services/tax/form26as'
import { formatINR, ZERO } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty, DataTable, type Column, type Tone } from '@/components/ui/kit'
import { Import26asForm } from './import-form'
import { currentFinancialYear } from '@/server/services/accounting/period'

const STATUS_TONE: Record<string, Tone> = {
  BOOKED: 'neutral', MATCHED_26AS: 'good', MISSING_IN_26AS: 'critical', DISPUTED: 'warn', CLAIMED: 'good',
}

export default async function TdsReceivablePage() {
  const ctx = await requireContext()
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return <Card><Empty title="No open financial year" icon="CalendarX" /></Card>

  const [summary, chase, entryCount] = await Promise.all([
    receivableSummary(ctx, fy.id),
    form16aChaseList(ctx, fy.id),
    prisma.form26asEntry.count({ where: { companyId: ctx.companyId, financialYearId: fy.id } }),
  ])
  const recon = entryCount > 0 ? await reconcile26as(ctx, fy.id) : null

  type Row = (typeof summary.rows)[number]
  const cols: Column<Row>[] = [
    { key: 'cust', header: 'Client', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.customerName}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.deductorTan ?? <span style={{ color: 'var(--critical)' }}>no TAN on record</span>} · {r.sectionCode}
            {r.invoiceNumber && ` · ${r.invoiceNumber}`}
          </span>
        </>
      ) },
    { key: 'q', header: 'Quarter', width: '9%', align: 'center', mobile: false,
      cell: (r) => <span className="tabular">Q{r.quarter}</span> },
    { key: 'base', header: 'On', width: '13%', align: 'right', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-muted)' }}>{formatINR(r.baseAmount, { decimals: false })}</span> },
    { key: 'books', header: 'In the books', width: '14%', align: 'right', mobile: 'value',
      cell: (r) => <span className="font-semibold">{formatINR(r.tdsAmount)}</span> },
    { key: '26as', header: 'In 26AS', width: '14%', align: 'right', mobile: false,
      cell: (r) => r.form26asAmount
        ? <span className="tabular">{formatINR(r.form26asAmount)}</span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'status', header: 'Status', width: '16%', align: 'center', mobile: 'tag',
      cell: (r) => (
        <span className="flex items-center justify-center gap-1.5">
          <Pill dot tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace(/_/g, ' ').toLowerCase()}</Pill>
          {!r.form16aReceived && <Pill tone="warn">no 16A</Pill>}
        </span>
      ) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="TDS receivable" sub={`FY ${fy.label} · what clients deducted from Adpedia`} />

      {summary.missing.gt(ZERO) && (
        <Alert tone="critical" title={`${formatINR(summary.missing)} is not showing in Form 26AS`}>
          A credit that never appears in 26AS cannot be claimed in the return — it is lost, not
          deferred. Chase the Form 16A from each client below.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Deducted by clients" value={formatINR(summary.booked, { decimals: false })} icon="ArrowDownLeft"
          foot={`${summary.rows.length} deduction${summary.rows.length === 1 ? '' : 's'} booked`} />
        <StatCard label="Confirmed in 26AS" value={formatINR(summary.matched, { decimals: false })} icon="CheckCircle2"
          foot={entryCount === 0 ? 'Import 26AS to reconcile' : 'Claimable in the return'} tone={summary.matched.gt(ZERO) ? 'accent' : 'default'} />
        <StatCard label="Not in 26AS" value={formatINR(summary.missing, { decimals: false })} icon="AlertTriangle"
          foot={summary.missing.gt(ZERO) ? 'Chase Form 16A' : 'Nothing outstanding'} />
        <StatCard label="In 26AS, not in books" value={formatINR(recon?.totals.extraAmount ?? ZERO, { decimals: false })} icon="Search"
          foot={recon && recon.notInBooks.length > 0 ? 'Possible unrecorded income' : 'Nothing unexplained'} />
      </div>

      {recon && recon.notInBooks.length > 0 && (
        <div className="space-y-2.5">
          {recon.notInBooks.map((n) => (
            <Alert key={n.entryId} tone="warn" title={`${n.deductorName} — ${formatINR(n.amount)} in 26AS with nothing behind it`}>
              {n.action}
            </Alert>
          ))}
        </div>
      )}

      <Card>
        <CardHeader title="Import Form 26AS"
          sub="Paste the rows from the portal export — CSV, tab or caret delimited. A re-import replaces the previous one." />
        <Import26asForm />
      </Card>

      {chase.length > 0 && (
        <Card>
          <CardHeader title="Form 16A — chase list" sub={`${chase.length} client${chase.length === 1 ? '' : 's'} yet to issue a certificate`} />
          <div className="space-y-3">
            {chase.map((c) => (
              <div key={c.customerId} className="flex flex-wrap items-start justify-between gap-3 border-t pt-3 first:border-0 first:pt-0" style={{ borderColor: 'var(--rule)' }}>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium">{c.name}</p>
                  <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{c.message}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.overdueQuarters.length > 0 && <Pill tone="critical" dot>overdue</Pill>}
                  <span className="tabular font-semibold">{formatINR(c.amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By quarter" sub="Matched against outstanding" />
          {summary.byQuarter.length === 0 ? (
            <Empty icon="Calendar" title="Nothing booked yet" />
          ) : (
            <div className="space-y-3">
              {summary.byQuarter.map((q) => (
                <div key={q.quarter}>
                  <div className="flex items-baseline justify-between text-[12.5px]">
                    <span style={{ color: 'var(--text-secondary)' }}>Q{q.quarter} · {q.count} deduction{q.count === 1 ? '' : 's'}</span>
                    <span className="font-semibold tabular">{formatINR(q.booked, { decimals: false })}</span>
                  </div>
                  <div className="mt-1.5 flex h-2 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
                    <div style={{ width: `${q.booked.gt(ZERO) ? q.matched.div(q.booked).mul(100).toNumber() : 0}%`, background: 'var(--good)' }} />
                    <div style={{ width: `${q.booked.gt(ZERO) ? q.missing.div(q.booked).mul(100).toNumber() : 0}%`, background: 'var(--critical)' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="By client" sub="Largest gap first" />
          {summary.byCustomer.length === 0 ? (
            <Empty icon="Users" title="Nothing booked yet" />
          ) : (
            <div className="space-y-2.5">
              {summary.byCustomer.map((c) => (
                <div key={c.customerId} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="truncate">
                    {c.name}
                    {!c.tan && <Pill tone="critical">no TAN</Pill>}
                  </span>
                  <span className="shrink-0 tabular">
                    {formatINR(c.booked, { decimals: false })}
                    {c.missing.gt(ZERO) && <span style={{ color: 'var(--critical)' }}> · {formatINR(c.missing, { decimals: false })} missing</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card flush className="overflow-hidden">
        <CardHeader title="Every deduction" className="p-5 pb-4" sub={`FY ${fy.label}`} />
        <DataTable columns={cols} rows={summary.rows} keyOf={(r) => r.id}
          empty={<Empty icon="Receipt" title="No client has deducted TDS yet"
            hint="A deduction is recorded when a receipt is entered short of the invoice — the shortfall is the TDS the client kept." />} />
      </Card>
    </div>
  )
}
