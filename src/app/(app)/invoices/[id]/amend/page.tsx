import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { previewAmendment, amendmentDeadline } from '@/server/services/tax/gst-amendment'
import { PageHeader, Card, Alert } from '@/components/ui/kit'
import { AmendForm } from './form'

export default async function AmendPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const inv = await prisma.invoice.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { customer: { select: { name: true, stateCode: true, gstin: true } } },
  })
  if (!inv) notFound()

  const today = new Date().toISOString().slice(0, 10)
  let preview
  try {
    preview = await previewAmendment(ctx, { invoiceId: id, date: today, reason: 'preview' })
  } catch (e) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title="Amend" sub={inv.number} />
        <Alert tone="critical" title="This invoice cannot be amended">
          {e instanceof Error ? e.message : 'Unknown problem'}
        </Alert>
      </div>
    )
  }

  const deadline = amendmentDeadline(inv.date)

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader back={{ href: `/invoices/${id}`, label: 'Invoice' }} title={`Amend ${inv.number}`}
        sub={`${inv.customer.name} · filed in ${preview.originalPeriod}`} />

      <Alert tone={preview.withinDeadline ? 'info' : 'critical'}
        title={preview.withinDeadline
          ? `Amendable until ${deadline.toISOString().slice(0, 10)}`
          : `The deadline passed on ${deadline.toISOString().slice(0, 10)}`}>
        {preview.withinDeadline ? (
          <>Under s.37(3) an invoice may be amended until 30 November following the end of the
          financial year of supply. The amendment is reported in table 9A of a <strong>later</strong> return,
          against this invoice&rsquo;s number and date.</>
        ) : (
          <>The figures as filed are now the figures. A difference after this is settled between the
          parties rather than reported — talk to the CA.</>
        )}
      </Alert>

      <Card className="p-4">
        <p className="eyebrow">What this does not do</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {inv.number} is not edited and not re-issued. It stays exactly as the client holds it and as the
          portal received it. Only the <strong>difference</strong> is posted, dated in the period that reports
          the amendment — the invoice&rsquo;s own month is locked by the return that carried it.
        </p>
      </Card>

      <AmendForm
        invoiceId={inv.id}
        invoiceNumber={inv.number}
        today={today}
        current={{
          gstin: preview.original.gstin,
          stateCode: preview.original.placeOfSupply,
          taxableValue: preview.original.taxableValue.toFixed(2),
        }} />
    </div>
  )
}
