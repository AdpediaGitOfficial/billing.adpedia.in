import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR, amountInWords, Decimal } from '@/lib/money'
import { placeOfSupplyLabel, taxModeLabel } from '@/server/services/tax/tax-mode'
import { lutStatus } from '@/server/services/invoicing/lut'
import { Card, PageHeader, Pill, Button, Alert } from '@/components/ui/kit'
import { InvoiceActions } from './actions-client'
import { ShareInvoice } from '@/components/pwa/share-invoice'

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const inv = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      customer: true, project: true, lines: { orderBy: { position: 'asc' } },
      financialYear: true, lut: true,
    },
  })
  if (!inv) notFound()

  const isDraft = inv.status === 'DRAFT'
  const lut = inv.taxMode === 'EXPORT' ? await lutStatus(prisma, ctx.companyId, inv.financialYear.label) : null
  const journal = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'INVOICE', sourceId: inv.id },
    include: { lines: { include: { account: true } } },
  })

  const money = (v: unknown) => inv.currency === 'INR'
    ? formatINR(v as string)
    : `${inv.currency} ${Number(v).toFixed(2)}`

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={isDraft ? 'Draft invoice' : inv.number}
        sub={`${inv.customer.name} · ${taxModeLabel(inv.taxMode)}`}
        action={
          <div className="flex gap-2">
            <a href={`/api/invoices/${inv.id}/document`} target="_blank" rel="noreferrer">
              <Button variant="ghost">View document</Button>
            </a>
            {!isDraft && (
              <ShareInvoice invoiceId={inv.id} number={inv.number}
                customerName={inv.customer.name} total={money(inv.grandTotal.toString())} />
            )}
            {!isDraft && inv.status !== 'CANCELLED' && (
              <Link href={`/invoices/${inv.id}/credit-note`}><Button variant="ghost">Credit note</Button></Link>
            )}
            <Link href="/invoices"><Button variant="ghost">Back</Button></Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Pill tone={inv.status === 'PAID' ? 'good' : inv.status === 'CANCELLED' ? 'neutral' : isDraft ? 'neutral' : 'accent'}>
          {inv.status.replace('_', ' ')}
        </Pill>
        <Pill tone="neutral">Place of supply {placeOfSupplyLabel(inv.taxMode, inv.customer.stateCode)}</Pill>
        {inv.lut && <Pill tone="good">LUT {inv.lut.arn}</Pill>}
      </div>

      {lut && !lut.ok && (
        <div className="mb-4">
          <Alert tone="critical" title={`No LUT on file for FY ${inv.financialYear.label}`}>
            This export invoice cannot be sent zero-rated. File Form RFD-11 on the GST portal,
            or raise it with IGST instead.
          </Alert>
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              <th className="px-4 py-2.5 text-left eyebrow">Description</th>
              <th className="px-4 py-2.5 text-center eyebrow">SAC</th>
              <th className="px-4 py-2.5 text-center eyebrow">Qty</th>
              <th className="px-4 py-2.5 text-right eyebrow">Rate</th>
              <th className="px-4 py-2.5 text-right eyebrow">Taxable</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-3">
                  <p className="font-medium">{l.description}</p>
                  {l.detail && <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{l.detail}</p>}
                </td>
                <td className="px-4 py-3 text-center tabular">{l.sacCode ?? '—'}</td>
                <td className="px-4 py-3 text-center tabular">{Number(l.quantity)}</td>
                <td className="px-4 py-3 text-right tabular">{money(l.rate.toString())}</td>
                <td className="px-4 py-3 text-right tabular">{money(l.taxableValue.toString())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--text-muted)' }}>Total in words</p>
          <p className="mt-1.5 text-[13px] font-semibold">
            {amountInWords(inv.grandTotal.toString(), inv.currency === 'INR' ? 'Indian Rupees' : 'US Dollars')}
          </p>
        </Card>

        <Card className="p-4">
          <dl className="text-[13px]">
            <Row k="Taxable value" v={money(inv.taxableValue.toString())} />
            {new Decimal(inv.cgst.toString()).gt(0) && <Row k="CGST" v={money(inv.cgst.toString())} />}
            {new Decimal(inv.sgst.toString()).gt(0) && <Row k="SGST" v={money(inv.sgst.toString())} />}
            {new Decimal(inv.igst.toString()).gt(0) && <Row k="IGST" v={money(inv.igst.toString())} />}
            {inv.taxMode === 'EXPORT' && <Row k="GST — zero rated" v="0.00" />}
            <Row k="Invoice total" v={money(inv.grandTotal.toString())} strong />
            {inv.tdsSection && (
              <>
                <Row k={`Less TDS u/s ${inv.tdsSection}`} v={`(${money(inv.tdsAmount.toString())})`} />
                <Row k="Net payable" v={money(inv.netPayable.toString())} strong />
              </>
            )}
            {new Decimal(inv.amountReceived.toString()).gt(0) && (
              <Row k="Received" v={money(inv.amountReceived.toString())} />
            )}
          </dl>
        </Card>
      </div>

      <InvoiceActions
        invoiceId={inv.id}
        status={inv.status}
        canSend={isDraft && (!lut || lut.ok)}
        blockedReason={lut && !lut.ok ? `No LUT for FY ${inv.financialYear.label}` : undefined}
      />

      {journal && (
        <Card className="mt-4 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--text-muted)' }}>
            Ledger entry #{journal.entryNo}
          </p>
          <table className="mt-2 w-full text-[12.5px]">
            <tbody>
              {journal.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1">{l.account.code} {l.account.name}</td>
                  <td className="py-1 text-right tabular">{new Decimal(l.debit.toString()).gt(0) ? formatINR(l.debit.toString()) : ''}</td>
                  <td className="py-1 text-right tabular">{new Decimal(l.credit.toString()).gt(0) ? formatINR(l.credit.toString()) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? 'border-t font-semibold' : ''}`} style={strong ? { borderColor: 'var(--rule)' } : undefined}>
      <dt style={{ color: strong ? undefined : 'var(--text-muted)' }}>{k}</dt>
      <dd className="tabular">{v}</dd>
    </div>
  )
}
