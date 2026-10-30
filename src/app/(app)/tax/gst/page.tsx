import Link from 'next/link'
import { requireContext } from '@/server/context'
import { gstOverview } from '@/server/services/tax/gst-dashboard'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Pill, Button, Alert, Empty, DataTable, type Column } from '@/components/ui/kit'
import { PeriodPicker } from './period-picker'
import { listGstFilings } from '@/server/services/tax/gst-filing'
import { Filings } from './filings'
import { Payments } from './payments'
import { listGstChallans, previewGstPayment } from '@/server/services/tax/gst-payment'
import { previewSetOff, listSetOffs } from '@/server/services/tax/gst-setoff'
import { electronicLedgers } from '@/server/services/tax/gst-electronic-ledgers'
import { ElectronicLedgers, toLedgerView } from './ledgers'
import { SetOff } from './setoff'
import { requireGstRegistered } from '@/components/shell/not-registered'

export default async function GstPage({ searchParams }: { searchParams: Promise<{ period?: string; on?: string }> }) {
  const ctx = await requireContext()
  // 🔴 docs/82 §5 — hidden from the rail is not refused
  const unregistered = await requireGstRegistered(ctx.companyId, 'GST')
  if (unregistered) return unregistered
  const { period, on } = await searchParams
  // 🔴 One date for the whole screen. The set-off plan depends on what the ledgers hold on
  // the day it is posted, so previewing as at today while the form posts another date would
  // show a shortfall that is not there, or hide one that is.
  const asAt = on && !Number.isNaN(Date.parse(on)) ? new Date(on) : new Date()
  const g = await gstOverview(ctx, period)
  const filings = await listGstFilings(ctx)
  const challans = await listGstChallans(ctx)

  if (!g) return <Card><Empty title="No open financial year" icon="CalendarX" /></Card>

  // the ledgers run for the whole year — unused credit and idle cash both carry forward
  const ledgers = await electronicLedgers(ctx, { from: g.fy.startsOn, to: g.fy.endsOn })
  const setOffs = await listSetOffs(ctx)
  const s = await previewSetOff(ctx, g.selected.label, asAt)
  const toDeposit = await previewGstPayment(ctx, g.selected.label, asAt)
  const d2 = (v: { toFixed: (n: number) => string }) => v.toFixed(2)
  const setOffView = {
    periodLabel: s.periodLabel,
    dueOn: s.dueOn.toISOString().slice(0, 10),
    asAt: asAt.toISOString().slice(0, 10),
    rows: [
      { head: 'IGST', liability: d2(s.liability.igst), byCredit: d2(s.plan.credit.igstToIgst.plus(s.plan.credit.cgstToIgst).plus(s.plan.credit.sgstToIgst)), inCash: d2(s.plan.cash.igst.minus(s.plan.cashToRcm)), short: d2(s.plan.shortfall.igst.minus(s.liability.rcm.minus(s.plan.cashToRcm))) },
      { head: 'CGST', liability: d2(s.liability.cgst), byCredit: d2(s.plan.credit.igstToCgst.plus(s.plan.credit.cgstToCgst)), inCash: d2(s.plan.cash.cgst), short: d2(s.plan.shortfall.cgst) },
      { head: 'SGST', liability: d2(s.liability.sgst), byCredit: d2(s.plan.credit.igstToSgst.plus(s.plan.credit.sgstToSgst)), inCash: d2(s.plan.cash.sgst), short: d2(s.plan.shortfall.sgst) },
      { head: 'Reverse charge (cash only)', liability: d2(s.liability.rcm), byCredit: '0', inCash: d2(s.plan.cashToRcm), short: d2(s.liability.rcm.minus(s.plan.cashToRcm)) },
    ],
    interestRow: s.liability.interest.plus(s.liability.lateFee).gt(0)
      ? { due: d2(s.liability.interest.plus(s.liability.lateFee)), inCash: d2(s.plan.cash.other), short: d2(s.plan.shortfall.other) }
      : null,
    creditUsed: d2(s.plan.credit.total),
    cashUsed: d2(s.plan.cash.total),
    shortTotal: d2(s.plan.shortfall.total),
    interestToDate: { days: s.interestToDate.days, interest: d2(s.interestToDate.interest) },
    notes: s.plan.notes,
    warnings: s.warnings,
    history: setOffs.map((r) => ({
      id: r.id, periodLabel: r.periodLabel,
      setOffOn: r.setOffOn.toISOString().slice(0, 10),
      creditUsed: r.creditUsed.toString(), cashUsed: r.cashUsed.toString(),
      cancelled: r.cancelledAt !== null,
    })),
  }

  const r1 = g.gstr1, r3 = g.gstr3b
  const cashPayable = r3.payable.inCash.plus(r3.payable.rcmInCash)
  const strandedTotal = r3.payable.strandedCredit.igst
    .plus(r3.payable.strandedCredit.cgst).plus(r3.payable.strandedCredit.sgst)

  type B2B = (typeof r1.b2b)[number]
  const b2bCols: Column<B2B>[] = [
    { key: 'inv', header: 'Invoice', mobile: 'primary', cell: (r) => <span className="font-semibold tabular">{r.invoiceNumber}</span> },
    { key: 'cust', header: 'Recipient', mobile: 'secondary', cell: (r) => <><span className="block">{r.customerName}</span><span className="block text-[11px] tabular" style={{ color: 'var(--text-muted)' }}>{r.gstin}</span></> },
    { key: 'pos', header: 'POS', align: 'center', width: '8%', mobile: false, cell: (r) => <span className="tabular">{r.placeOfSupply}</span> },
    { key: 'rate', header: 'Rate', align: 'center', width: '8%', mobile: false, cell: (r) => <span className="tabular">{r.rate}%</span> },
    { key: 'taxable', header: 'Taxable', align: 'right', mobile: 'value', cell: (r) => formatINR(r.taxableValue) },
    { key: 'tax', header: 'Tax', align: 'right', mobile: false, cell: (r) => formatINR(r.cgst.plus(r.sgst).plus(r.igst)) },
  ]

  type Hsn = (typeof r1.hsn)[number]
  const hsnCols: Column<Hsn>[] = [
    { key: 'sac', header: 'SAC', mobile: 'primary', cell: (r) => <span className="font-semibold tabular">{r.sac}</span> },
    { key: 'desc', header: 'Description', mobile: 'secondary', cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.description}</span> },
    { key: 'qty', header: 'Qty', align: 'center', width: '8%', mobile: false, cell: (r) => <span className="tabular">{Number(r.quantity)}</span> },
    { key: 'taxable', header: 'Taxable value', align: 'right', mobile: 'value', cell: (r) => formatINR(r.taxableValue) },
    { key: 'tax', header: 'Tax', align: 'right', mobile: false, cell: (r) => formatINR(r.cgst.plus(r.sgst).plus(r.igst)) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="GST"
        sub={`${g.frequency === 'QUARTERLY' ? 'Quarterly filing (QRMP)' : 'Monthly filing'} · FY ${g.fy.label}`}
        action={
          <>
            <Link href="/tax/portal"><Button variant="ghost" icon="ShieldCheck">Check the portal</Button></Link>
            <a href={`/api/tax/gst/export?return=gstr1&period=${g.selected.label}`}>
              <Button variant="ghost" icon="Download">GSTR-1 CSV</Button>
            </a>
            <a href={`/api/tax/gst/export?return=gstr3b&period=${g.selected.label}`}>
              <Button variant="ghost" icon="Download">GSTR-3B CSV</Button>
            </a>
          </>
        }
      />

      <PeriodPicker periods={g.periods.map((p) => ({ label: p.label, title: p.title }))} selected={g.selected.label} />

      <Filings
        periods={g.periods.map((p) => ({ label: p.label }))}
        filings={filings.map((f) => ({
          id: f.id, returnType: f.returnType, periodLabel: f.periodLabel,
          filedOn: f.filedOn ? f.filedOn.toISOString().slice(0, 10) : null,
          arn: f.arn, status: f.status, netPayable: f.netPayable.toFixed(2),
        }))} />

      <Payments
        periods={g.periods.map((p) => ({ label: p.label }))}
        deposit={{
          periodLabel: s.periodLabel, asAt: asAt.toISOString().slice(0, 10),
          igst: d2(toDeposit.deposit.igst), cgst: d2(toDeposit.deposit.cgst),
          sgst: d2(toDeposit.deposit.sgst), total: d2(toDeposit.deposit.total),
        }}
        challans={challans.map((c) => ({
          id: c.id, periodLabel: c.periodLabel, cin: c.cin,
          paidOn: c.paidOn.toISOString().slice(0, 10),
          amount: c.amount.toString(), interest: c.interest.toString(), lateFee: c.lateFee.toString(),
        }))} />

      {/* ── the portal's two ledgers, and the step that debits them ───────── */}
      <ElectronicLedgers
        cash={toLedgerView(ledgers.cash)}
        credit={toLedgerView(ledgers.credit)}
        fyLabel={g.fy.label} />

      <SetOff view={setOffView} />

      {!g.lut && (
        <Alert tone="critical" title={`No LUT on file for FY ${g.fy.label}`}
          action={<Link href="/settings/lut"><Button size="sm" variant="ghost">LUT register</Button></Link>}>
          Export invoices cannot be zero-rated without a Letter of Undertaking. File Form RFD-11 on
          the GST portal, or raise exports with payment of IGST and claim the refund.
        </Alert>
      )}

      {r1.warnings.map((w) => <Alert key={w} tone="warn" title="Check before filing">{w}</Alert>)}

      {/* ── position ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Output GST" value={formatINR(g.position.output.total, { decimals: false })} icon="ArrowUpRight"
          foot={`CGST ${formatINR(g.position.output.cgst, { decimals: false })} · SGST ${formatINR(g.position.output.sgst, { decimals: false })} · IGST ${formatINR(g.position.output.igst, { decimals: false })}`} />
        <StatCard label="Input tax credit" value={formatINR(g.position.input.total, { decimals: false })} icon="ArrowDownLeft"
          foot={g.position.input.total.isZero() ? 'Vendor bills arrive in phase 3' : 'Claimable this period'} />
        {/* 🔴 Not output-less-ITC. That netting is what docs/46 corrected: credit is utilised
            head-wise, so the cash actually payable can be higher than the difference of the
            two totals — and the card sat next to table 6.1 contradicting it. */}
        <StatCard label="Payable in cash" value={formatINR(cashPayable, { decimals: false })} icon="Scale"
          tone="accent"
          foot={strandedTotal.gt(0)
            ? `After head-wise set-off · ${formatINR(strandedTotal, { decimals: false })} of credit carries forward`
            : 'After head-wise set-off, including reverse charge'} />
        <StatCard label="Reverse charge" value={formatINR(g.position.rcm.payable, { decimals: false })} icon="RefreshCw"
          foot="Payable in cash — never set off against ITC" />
      </div>

      {/* ── filing status ────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {([
          { name: 'GSTR-1', due: g.selected.gstr1DueOn, days: g.due.gstr1Days, filed: g.filed.gstr1, note: 'Outward supplies' },
          { name: 'GSTR-3B', due: g.selected.gstr3bDueOn, days: g.due.gstr3bDays, filed: g.filed.gstr3b, note: 'Summary and payment' },
        ] as const).map((f) => (
          <Card key={f.name}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">{f.name}</p>
                <p className="mt-1 text-[15px] font-semibold">{f.note}</p>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Due {f.due.toISOString().slice(0, 10)}
                </p>
              </div>
              {f.filed
                ? <Pill tone="good" dot>Filed</Pill>
                : <Pill dot tone={f.days < 0 ? 'critical' : f.days <= 7 ? 'warn' : 'neutral'}>
                    {f.days < 0 ? `${Math.abs(f.days)}d overdue` : f.days === 0 ? 'Due today' : `${f.days}d left`}
                  </Pill>}
            </div>
          </Card>
        ))}
      </div>

      {/* ── GSTR-3B summary ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="GSTR-3B summary" sub={`${g.selected.title} · prepared for review, not filed`} />
        <dl className="text-[13px]">
          <TaxRow k="3.1(a) Outward taxable supplies" v={formatINR(r3.t31a.taxable)} tax={formatINR(r3.t31a.cgst.plus(r3.t31a.sgst).plus(r3.t31a.igst))} />
          <TaxRow k="3.1(b) Zero-rated supplies" v={formatINR(r3.t31b.taxable)} tax={formatINR(r3.t31b.igst)} />
          <TaxRow k="3.1(d) Inward supplies under reverse charge" v={formatINR(r3.t31d.taxable)} tax={formatINR(r3.t31d.igst)} />
          <TaxRow k="4(C) Net ITC available" v="" tax={formatINR(r3.t4c)} />
          <TaxRow k="6.1 Payable through ITC" v="" tax={formatINR(r3.payable.throughItc)} />
          {/* 🔴 head-wise, because credit is utilised head-wise — a single total can say
              nothing is payable while the portal asks for cash on one head */}
          <TaxRow k="6.1 — IGST in cash" v={`credit ${formatINR(r3.payable.byHead.igst.byCredit)}`} tax={formatINR(r3.payable.byHead.igst.inCash)} />
          <TaxRow k="6.1 — CGST in cash" v={`credit ${formatINR(r3.payable.byHead.cgst.byCredit)}`} tax={formatINR(r3.payable.byHead.cgst.inCash)} />
          <TaxRow k="6.1 — SGST in cash" v={`credit ${formatINR(r3.payable.byHead.sgst.byCredit)}`} tax={formatINR(r3.payable.byHead.sgst.inCash)} />
          {r3.payable.rcmInCash.gt(0) && (
            <TaxRow k="6.1 — reverse charge, cash only" v="credit not allowed" tax={formatINR(r3.payable.rcmInCash)} />
          )}
          <TaxRow k="6.1 Payable in cash" v="" tax={formatINR(r3.payable.inCash.plus(r3.payable.rcmInCash))} strong />
        </dl>
        {r3.notes.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {r3.notes.map((n) => (
              <li key={n} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>· {n}</li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── GSTR-1 tables ────────────────────────────────────────────────── */}
      <Card flush className="overflow-hidden">
        <CardHeader title="B2B invoices" className="p-5 pb-4"
          sub={`${r1.b2b.length} row${r1.b2b.length === 1 ? '' : 's'} · table b2b of GSTR-1`} />
        <DataTable columns={b2bCols} rows={r1.b2b} keyOf={(r) => `${r.invoiceNumber}-${r.rate}`}
          empty={<Empty icon="FileText" title="No B2B supplies in this period" hint="Invoices to GST-registered customers appear here." />} />
      </Card>

      {r1.exports.length > 0 && (
        <Card flush className="overflow-hidden">
          <CardHeader title="Exports" className="p-5 pb-4" sub="Table exp of GSTR-1" />
          <div className="px-5 pb-5">
            {r1.exports.map((e) => (
              <div key={e.invoiceNumber} className="flex items-center justify-between border-t py-3 text-[13px]" style={{ borderColor: 'var(--rule)' }}>
                <div>
                  <span className="font-semibold tabular">{e.invoiceNumber}</span>
                  <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>{e.customerName}</span>
                  <Pill tone={e.exportType === 'WOPAY' ? 'good' : 'warn'}>{e.exportType === 'WOPAY' ? 'Under LUT' : 'With IGST'}</Pill>
                </div>
                <span className="tabular font-semibold">{e.currency} {Number(e.taxableValue).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card flush className="overflow-hidden">
        <CardHeader title="HSN / SAC summary" className="p-5 pb-4"
          sub="Required in GSTR-1 whether or not the invoice prints the code" />
        <DataTable columns={hsnCols} rows={r1.hsn} keyOf={(r) => r.sac}
          empty={<Empty icon="Hash" title="Nothing to summarise yet" />} />
      </Card>
    </div>
  )
}

function TaxRow({ k, v, tax, strong }: { k: string; v: string; tax: string; strong?: boolean }) {
  return (
    <div className={`grid grid-cols-[1fr_auto_auto] gap-4 border-t py-2 ${strong ? 'font-semibold' : ''}`} style={{ borderColor: 'var(--rule)' }}>
      <dt style={{ color: strong ? undefined : 'var(--text-secondary)' }}>{k}</dt>
      <dd className="w-28 text-right tabular" style={{ color: 'var(--text-muted)' }}>{v}</dd>
      <dd className="w-28 text-right tabular">{tax}</dd>
    </div>
  )
}
