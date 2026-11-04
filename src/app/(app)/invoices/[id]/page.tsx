import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { archivedDocument } from '@/server/services/storage/document-archive'
import { prisma } from '@/server/db'
import { formatINR, amountInWords, Decimal } from '@/lib/money'
import { placeOfSupplyLabel, taxModeLabel } from '@/server/services/tax/tax-mode'
import { lutStatus } from '@/server/services/invoicing/lut'
import { carriesTax } from '@/server/services/invoicing/document-type'
import { Card, PageHeader, Pill, Button, Alert } from '@/components/ui/kit'
import { InvoiceActions } from './actions-client'
import { ShareInvoice } from '@/components/pwa/share-invoice'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelCreditNoteAction } from './credit-note/actions'

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const inv = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      customer: true, project: true, lines: { orderBy: { position: 'asc' } },
      financialYear: true, lut: true,
      // docs/48 — raised credit notes were reachable from nowhere once issued
      creditNotes: { orderBy: { date: 'asc' } },
      // docs/52 — what was reported about this invoice after it was filed
      gstAmendments: { orderBy: { date: 'asc' } },
    },
  })
  if (!inv) notFound()

  const isDraft = inv.status === 'DRAFT'
  // 🔴 docs/82 §4 — a bill of supply for an overseas client needs no LUT, so it is not missing one
  const lut = inv.taxMode === 'EXPORT' && carriesTax(inv.docType)
    ? await lutStatus(prisma, ctx.companyId, inv.financialYear.label)
    : null
  const journal = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'INVOICE', sourceId: inv.id },
    include: { lines: { include: { account: true } } },
  })

  const live = inv.creditNotes.filter((c) => !c.cancelledAt)
  const credited = live
    .filter((c) => c.noteType === 'CREDIT')
    .reduce((a, c) => a.plus(c.grandTotal.toString()), new Decimal(0))
  const debited = live
    .filter((c) => c.noteType === 'DEBIT')
    .reduce((a, c) => a.plus(c.grandTotal.toString()), new Decimal(0))

  const money = (v: unknown) => inv.currency === 'INR'
    ? formatINR(v as string)
    : `${inv.currency} ${Number(v).toFixed(2)}`

  // docs/59 — is there a copy of what was actually issued?
  const archived = isDraft ? null : await archivedDocument(ctx.companyId, 'Invoice', inv.id)

  return (
    <div className="max-w-3xl">
      <PageHeader back={{ href: '/invoices', label: 'Invoices' }}
        title={isDraft ? 'Draft invoice' : inv.number}
        sub={`${inv.customer.name} · ${taxModeLabel(inv.taxMode)}`}
        action={
          <div className="flex flex-wrap gap-2">
            <a href={`/api/invoices/${inv.id}/document`} target="_blank" rel="noreferrer">
              <Button variant="ghost">{archived ? 'The invoice as issued' : 'View document'}</Button>
            </a>
            {/* 🔴 docs/83 §6 — looking at it and having the file are two different asks.
                `download` on the anchor names the file; `?download=1` makes the response say
                `attachment` too, because a cross-origin or redirected response ignores the
                attribute and this route must work the same either way. */}
            <a href={`/api/invoices/${inv.id}/document?download=1`}
              download={`${inv.number.replace(/\//g, '-')}.pdf`}>
              <Button variant="ghost" icon="Download">PDF</Button>
            </a>
            {/* docs/70 — a draft can be corrected now rather than cancelled and re-raised */}
            {isDraft && (
              <Link href={`/invoices/${inv.id}/edit`}><Button variant="ghost" icon="Pencil">Edit</Button></Link>
            )}
            {!isDraft && (
              <ShareInvoice invoiceId={inv.id} number={inv.number}
                customerName={inv.customer.name} total={money(inv.grandTotal.toString())} />
            )}
            {!isDraft && inv.status !== 'CANCELLED' && (
              <Link href={`/invoices/${inv.id}/credit-note`}><Button variant="ghost">Credit note</Button></Link>
            )}
            {!isDraft && inv.status !== 'CANCELLED' && (
              <Link href={`/invoices/${inv.id}/debit-note`}><Button variant="ghost">Debit note</Button></Link>
            )}
            {!isDraft && inv.status !== 'CANCELLED' && (
              <Link href={`/invoices/${inv.id}/amend`}><Button variant="ghost">Amend</Button></Link>
            )}
          </div>
        }
      />

      {/* 🔴 docs/59 — an invoice sent before the archive existed, or whose render failed, has
          no copy of what the client received. Reprinting it uses today's template and today's
          company details: a different document with the same number. */}
      {!isDraft && inv.status !== 'CANCELLED' && !archived && (
        <div className="mb-4">
          <Alert tone="warn" title="No copy of this invoice as it was issued">
            It was sent before documents were archived, or its render failed at the time.
            &ldquo;View document&rdquo; rebuilds it from today&rsquo;s data and today&rsquo;s template — close to
            what the client received, and not the same file.
          </Alert>
        </div>
      )}

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
            {/* 🔴 A credited invoice still read as fully owed. The credit notes were listed
                further down the page and nothing connected them to the total, so the figure
                a reader takes away was the one before the credit. */}
            {debited.gt(0) && (
              <Row k="Add: debit notes" v={money(debited.toString())} />
            )}
            {credited.gt(0) && (
              <Row k="Less: credit notes" v={`(${money(credited.toString())})`} />
            )}
            {(credited.gt(0) || debited.gt(0)) && (
              <Row k="Net after notes"
                v={money(new Decimal(inv.grandTotal.toString()).minus(credited).plus(debited).toString())} strong />
            )}
            {new Decimal(inv.amountReceived.toString()).gt(0) && (
              <Row k="Received" v={money(inv.amountReceived.toString())} />
            )}
          </dl>
        </Card>
      </div>

      {inv.creditNotes.length > 0 && (
        <Card className="mt-4 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--text-muted)' }}>
            Notes against this invoice
          </p>
          <table className="mt-2 w-full text-[12.5px]">
            <tbody>
              {inv.creditNotes.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 font-medium"
                    style={c.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
                    {c.number}
                  </td>
                  <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>
                    {c.date.toISOString().slice(0, 10)}
                  </td>
                  <td className="py-2" style={{ color: 'var(--text-secondary)' }}>{c.reason}</td>
                  <td className="py-2">
                    {/* 🔴 A commercial note credits the client without recovering any GST,
                        and it is not in GSTR-1 — which is worth seeing before the CA asks.
                        A cancelled one is neither, so it says nothing about tax at all. */}
                    {c.cancelledAt
                      ? null
                      : c.noteType === 'DEBIT'
                        ? <Pill tone="accent">debit · charged</Pill>
                        : c.gstAdjusted
                          ? <Pill tone="neutral">GST adjusted</Pill>
                          : <Pill tone="warn">commercial · no GST</Pill>}
                  </td>
                  <td className="py-2 text-right font-semibold tabular"
                    style={c.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
                    {money(c.grandTotal.toString())}
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <span className="flex items-center justify-end gap-3">
                      <a href={`/api/credit-notes/${c.id}/document`} target="_blank" rel="noreferrer"
                        className="text-[12px] underline underline-offset-2" style={{ color: 'var(--accent)' }}>
                        Document
                      </a>
                      {c.cancelledAt
                        ? <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>cancelled</span>
                        : <>
                            {/* docs/66 — once the note has been filed it is amended, not edited */}
                            <Link href={`/notes/${c.id}/amend`}
                              className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>amend</Link>
                            <ReverseButton action={cancelCreditNoteAction} idName="noteId" id={c.id}
                              prompt={`Why is ${c.number} being reversed?`} />
                          </>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {inv.gstAmendments.length > 0 && (
        <Card className="mt-4 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--text-muted)' }}>
            Amendments reported
          </p>
          <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {inv.number} itself is unchanged — these were reported in table 9A of a later return.
          </p>
          <table className="mt-2 w-full text-[12.5px]">
            <tbody>
              {inv.gstAmendments.map((a) => (
                <tr key={a.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>{a.periodLabel}</td>
                  <td className="py-2">{a.reason}</td>
                  <td className="py-2 text-right tabular">
                    {a.revisedTaxMode === 'INTRA' ? 'CGST + SGST' : a.revisedTaxMode === 'INTER' ? 'IGST' : a.revisedTaxMode}
                    {' · '}POS {a.revisedPlaceOfSupply}
                  </td>
                  <td className="py-2 text-right font-semibold tabular">{money(a.revisedGrandTotal.toString())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
