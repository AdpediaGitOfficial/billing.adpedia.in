import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { can } from '@/server/auth/permissions'
import { previewRebook } from '@/server/services/invoicing/rebook'
import { formatINR } from '@/lib/money'
import { parseFxRate, plainRate, showRate } from '@/lib/fx'
import { liveRate } from '@/server/services/fx-rates'
import { PageHeader, Card, Alert, Button, inputClass, inputStyle, Field } from '@/components/ui/kit'
import { ConfirmRebook } from './confirm-form'

/**
 * docs/92 — book an invoice that was issued at face value at its real exchange rate.
 *
 * Two steps on one URL, with no client state: the rate goes in as a query string, the page
 * works out the correction and SHOWS it, and only then does a button post it. The figures a
 * person confirms are the figures that post, because both come from `previewRebook`.
 */
export default async function RebookPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ rate?: string; date?: string }>
}) {
  const { id } = await params
  const { rate = '', date = '' } = await searchParams
  const ctx = await requireContext()

  const inv = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId }, include: { customer: { select: { name: true } } },
  })
  if (!inv) notFound()

  if (!can(ctx.role, 'invoices.cancel', 'approve')) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title="Book at an exchange rate" sub={inv.number} />
        <Alert tone="critical" title="You cannot post this correction">
          Correcting an issued invoice takes the same approval as cancelling one. Ask an owner or accountant.
        </Alert>
      </div>
    )
  }

  // docs/94 — the rate FOR THE INVOICE'S DATE, not today's: a correction books what it should have been
  const suggestion = await liveRate(inv.currency, (date || inv.date.toISOString().slice(0, 10))).catch(() => null)
  const hasRate = parseFxRate(rate) !== null
  let preview = null
  let problem: string | null = null
  if (hasRate) {
    try { preview = await previewRebook(ctx, { invoiceId: id, fxRate: rate, date: date || undefined }) }
    catch (e) { problem = e instanceof Error ? e.message : 'Could not work that out' }
  } else if (rate) {
    problem = 'The exchange rate must be a positive number — rupees per one unit of the invoice currency.'
  }

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title={`Book ${inv.number} at an exchange rate`}
        sub={`${inv.customer.name} · ${inv.currency} ${Number(inv.grandTotal).toFixed(2)}`} />

      <Alert tone="info" title="What this does">
        This invoice was issued before exchange rates were captured, so the ledger holds its{' '}
        {inv.currency} amount as if it were rupees. The invoice, its number and the document the
        client holds do not change. A separate entry corrects the ledger by the difference.
      </Alert>

      <Card className="p-5">
        <form method="get" className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={`Exchange rate (₹ per 1 ${inv.currency})`} hint="The rate on the invoice date.">
            <input name="rate" defaultValue={rate || (suggestion && suggestion.requested === (date || inv.date.toISOString().slice(0, 10)) ? plainRate(suggestion.rate.toFixed(6)) : '')} inputMode="decimal" placeholder="e.g. 94.14"
              className={inputClass} style={inputStyle} />
            {suggestion && (
              <p className="mt-1 text-[11.5px]" style={{ color: suggestion.stale ? 'var(--warn)' : 'var(--text-muted)' }}>
                {suggestion.requested !== (date || inv.date.toISOString().slice(0, 10))
                  ? `No rate for that date — the latest held is from ${suggestion.requested}: `
                  : `${suggestion.stale ? 'Last known rate' : 'Rate'} for ${suggestion.requested}: `}
                ₹{showRate(suggestion.rate.toFixed(6))} · {suggestion.source}, {suggestion.asOf}
              </p>
            )}
          </Field>
          <Field label="Date of the correction" hint="Defaults to the invoice date.">
            <input name="date" type="date" defaultValue={date} className={inputClass} style={inputStyle} />
          </Field>
          <Button type="submit" variant="soft">Show the correction</Button>
        </form>
      </Card>

      {problem && <Alert tone="critical" title="That cannot be worked out">{problem}</Alert>}

      {preview && preview.blockers.length > 0 && (
        <Alert tone="critical" title="This invoice cannot be re-booked yet">
          <ul className="list-disc space-y-1 pl-4">{preview.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Alert>
      )}

      {preview && preview.blockers.length === 0 && (
        <>
          <Card flush className="overflow-hidden">
            <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
              <span className="eyebrow">
                Entry dated {preview.entryDate.toISOString().slice(0, 10)} · at ₹{preview.fxRate.toFixed(4)} per {preview.currency}
              </span>
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="px-4 py-2 text-left font-semibold">Account</th>
                  <th className="px-2 py-2 text-right font-semibold">Booked as</th>
                  <th className="px-2 py-2 text-right font-semibold">Should be</th>
                  <th className="px-4 py-2 text-right font-semibold">Correction</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.accountCode} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="px-4 py-2">{l.accountCode} {l.accountName}</td>
                    <td className="px-2 py-2 text-right tabular">{formatINR(l.was.toString())}</td>
                    <td className="px-2 py-2 text-right tabular">{formatINR(l.now.toString())}</td>
                    <td className="px-4 py-2 text-right tabular font-semibold">
                      {l.delta.gt(0) ? 'Dr ' : l.delta.lt(0) ? 'Cr ' : ''}{formatINR(l.delta.abs().toString())}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t px-4 py-2.5 text-[11.5px]" style={{ borderColor: 'var(--rule)', color: 'var(--text-muted)' }}>
              Debits are positive, credits negative. Receivables goes from {formatINR(preview.receivableWas.toString())} to{' '}
              {formatINR(preview.receivableNow.toString())}.
            </p>
          </Card>

          {preview.warnings.map((w) => <Alert key={w} tone="warn" title="Note">{w}</Alert>)}

          <ConfirmRebook invoiceId={id} fxRate={rate} date={date} backHref={`/invoices/${id}`} />
        </>
      )}
    </div>
  )
}
