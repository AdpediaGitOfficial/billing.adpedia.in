import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { previewDebitNote } from '@/server/services/invoicing/debit-note'
import { PageHeader, Card, Alert } from '@/components/ui/kit'
import { DebitNoteForm } from './form'

export default async function NewDebitNotePage({ params }: { params: Promise<{ id: string }> }) {
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
    preview = await previewDebitNote(ctx, { invoiceId: id, date: today, taxableValue: '0' })
  } catch (e) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageHeader title="Debit note" sub={inv.number} />
        <Alert tone="critical" title="This invoice cannot carry a debit note">
          {e instanceof Error ? e.message : 'Unknown problem'}
        </Alert>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Debit note" sub={`Against ${inv.number} · ${inv.customer.name}`} />

      {/* 🔴 The asymmetry that is easy to get wrong by reading across from the credit note. */}
      <Alert tone="info" title="A debit note has no deadline">
        Section 34(2) time-bars a <strong>credit</strong> note to 30 November following the financial year,
        because a credit note reduces the government&rsquo;s tax. A debit note increases it, so nothing
        restricts when it may be issued.
      </Alert>

      <Card className="p-4">
        <p className="eyebrow">What the client sees</p>
        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {preview.notes.map((n) => <li key={n}>&bull; {n}</li>)}
        </ul>
      </Card>

      {preview.warnings.filter((w) => !w.includes('positive value')).map((w) => (
        <Alert key={w} tone="warn" title="Worth knowing first">{w}</Alert>
      ))}

      <DebitNoteForm invoiceId={inv.id} invoiceNumber={inv.number} today={today} taxMode={inv.taxMode} />
    </div>
  )
}
