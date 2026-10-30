import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { previewCreditNote, gstAdjustmentDeadline } from '@/server/services/invoicing/credit-note'
import { formatINR } from '@/lib/money'
import { PageHeader, Card, Alert } from '@/components/ui/kit'
import { CreditNoteForm } from './form'

export default async function NewCreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const inv = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { customer: { select: { name: true } } },
  })
  if (!inv) notFound()

  const today = new Date().toISOString().slice(0, 10)
  let preview
  try {
    preview = await previewCreditNote(ctx, { invoiceId: id, date: today, full: true })
  } catch (e) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title="Credit note" sub={inv.number} />
        <Alert tone="critical" title="This invoice cannot be credited">
          {e instanceof Error ? e.message : 'Unknown problem'}
        </Alert>
      </div>
    )
  }

  const deadline = gstAdjustmentDeadline(inv.date)

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title="Credit note"
        sub={`Against ${inv.number} · ${inv.customer.name}`} />

      <Alert tone={preview.gstAdjustable ? 'info' : 'critical'}
        title={preview.gstAdjustable
          ? `GST can be adjusted until ${deadline.toISOString().slice(0, 10)}`
          : `The deadline for adjusting GST passed on ${deadline.toISOString().slice(0, 10)}`}>
        {preview.gstAdjustable ? (
          <>Under s.34(2) a credit note reduces output tax only if it is issued by 30 November
          following the end of the financial year of supply. After that it is still valid between
          you and the client &mdash; but the GST already paid cannot be recovered.</>
        ) : (
          <>A credit note raised now is valid between you and the client, and the invoice value
          drops. The <strong>GST already paid on it cannot be recovered</strong>. Raise it anyway if
          the commercial position needs it, and tell the CA.</>
        )}
      </Alert>

      <Card className="p-4">
        <p className="eyebrow">A credit note is not a cancellation</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {inv.number} stays issued and stays reported. The credit note is its own document with
          its own number, reported separately in GSTR-1, that reduces what is owed. A tax invoice
          that has been acted on cannot be unsaid &mdash; which is why this exists rather than an edit.
        </p>
      </Card>

      <CreditNoteForm
        invoiceId={inv.id}
        invoiceNumber={inv.number}
        today={today}
        creditable={preview.creditable.toFixed(2)}
        creditableLabel={formatINR(preview.creditable)}
        taxMode={inv.taxMode}
        ratePct={preview.taxableValue.gt(0)
          ? preview.cgst.plus(preview.sgst).plus(preview.igst).div(preview.taxableValue).mul(100).toFixed(0)
          : '0'} />
    </div>
  )
}
