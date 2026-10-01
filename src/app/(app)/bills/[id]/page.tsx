import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR, Decimal } from '@/lib/money'
import { Card, CardHeader, PageHeader, Pill, Button, Alert } from '@/components/ui/kit'
import { BillActions } from './actions-client'
import { listAttachments } from '@/server/services/storage/attachment'
import { AttachmentPanel } from '@/components/attachments/attachment-panel'

export default async function BillDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const bill = await prisma.vendorBill.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { vendor: true, project: true, lines: true, payments: { orderBy: { date: 'desc' } } },
  })
  if (!bill) notFound()

  const entries = await prisma.journalEntry.findMany({
    where: { companyId: ctx.companyId, sourceId: bill.id },
    include: { lines: { include: { account: true } } },
    orderBy: { entryNo: 'asc' },
  })

  const attachments = await listAttachments(ctx, 'VendorBill', bill.id)

  const total = new Decimal(bill.grandTotal.toString())
  const tds = new Decimal(bill.tdsAmount.toString())
  const paid = new Decimal(bill.amountPaid.toString())
  const owed = total.minus(tds).minus(paid)

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title={bill.billNumber} sub={`${bill.vendor.name}${bill.project ? ` · ${bill.project.name}` : ''}`}
        action={<Link href="/bills"><Button variant="ghost">Back</Button></Link>} />

      <AttachmentPanel
        entityType="VendorBill" entityId={bill.id} kind="VENDOR_INVOICE"
        title="The vendor's invoice"
        hint="Rule 36(1) — input credit is claimable against a tax invoice you hold. Keep a copy here."
        initial={attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes }))} />

      <div className="flex flex-wrap gap-2">
        <Pill dot tone={bill.status === 'PAID' ? 'good' : bill.status === 'CANCELLED' ? 'neutral' : bill.status === 'DRAFT' ? 'neutral' : 'accent'}>
          {bill.status.replace('_', ' ').toLowerCase()}
        </Pill>
        {bill.isRcm && <Pill tone="warn" dot>Reverse charge</Pill>}
        {bill.selfInvoiceNo && <Pill tone="accent">Self-invoice {bill.selfInvoiceNo}</Pill>}
        {bill.tdsSection && Number(bill.tdsAmount) > 0 && <Pill tone="accent">TDS {bill.tdsSection} @ {Number(bill.tdsRatePct)}%</Pill>}
        {!bill.itcEligible && <Pill tone="critical">ITC blocked</Pill>}
      </div>

      {bill.isRcm && bill.status !== 'DRAFT' && (
        <Alert tone="warn" title={`IGST ${formatINR(bill.rcmIgst.toString())} payable under reverse charge`}>
          Pay it in cash with the period&rsquo;s GST — it cannot be set off against existing input
          credit. The same amount is claimable as ITC in the same return, so the net cost is nil.
        </Alert>
      )}
      {!bill.itcEligible && bill.itcBlockedReason && (
        <Alert tone="critical" title="Input credit blocked">{bill.itcBlockedReason}</Alert>
      )}

      <Card flush className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <th className="px-4 py-2.5 text-left eyebrow">Description</th>
            <th className="px-4 py-2.5 text-center eyebrow">SAC</th>
            <th className="px-4 py-2.5 text-right eyebrow">Amount</th>
          </tr></thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-3">{l.description}</td>
                <td className="px-4 py-3 text-center tabular" style={{ color: 'var(--text-muted)' }}>{l.sacCode ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular">{formatINR(l.taxableValue.toString())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <dl className="ml-auto max-w-sm text-[13.5px]">
          <Row k="Taxable value" v={formatINR(bill.taxableValue.toString())} />
          {Number(bill.cgst) > 0 && <><Row k="CGST" v={formatINR(bill.cgst.toString())} /><Row k="SGST" v={formatINR(bill.sgst.toString())} /></>}
          {Number(bill.igst) > 0 && <Row k="IGST" v={formatINR(bill.igst.toString())} />}
          <Row k="Bill total" v={formatINR(total)} strong />
          {tds.gt(0) && <Row k={`Less TDS u/s ${bill.tdsSection}`} v={`(${formatINR(tds)})`} />}
          {paid.gt(0) && <Row k="Paid" v={formatINR(paid)} />}
          <Row k="Owed to the vendor" v={formatINR(owed)} strong />
        </dl>
      </Card>

      <BillActions billId={bill.id} status={bill.status} owed={owed.toFixed(2)} />

      {bill.payments.length > 0 && (
        <Card>
          <CardHeader title="Payments" />
          {bill.payments.map((p) => (
            <div key={p.id} className="flex justify-between border-t py-2 text-[13px]" style={{ borderColor: 'var(--rule)' }}>
              <span>{p.date.toISOString().slice(0, 10)} · {p.mode}{p.reference ? ` · ${p.reference}` : ''}</span>
              <span className="tabular font-semibold">{formatINR(p.amount.toString())}</span>
            </div>
          ))}
        </Card>
      )}

      {entries.map((e) => (
        <Card key={e.id}>
          <p className="eyebrow">Ledger entry #{e.entryNo} — {e.narration}</p>
          <table className="mt-2 w-full text-[12.5px]">
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1">{l.account.code} {l.account.name}</td>
                  <td className="py-1 text-right tabular">{Number(l.debit) > 0 ? formatINR(l.debit.toString()) : ''}</td>
                  <td className="py-1 text-right tabular">{Number(l.credit) > 0 ? formatINR(l.credit.toString()) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1 ${strong ? 'border-t font-semibold' : ''}`} style={strong ? { borderColor: 'var(--rule)' } : undefined}>
      <dt style={{ color: strong ? undefined : 'var(--text-secondary)' }}>{k}</dt>
      <dd className="tabular">{v}</dd>
    </div>
  )
}
