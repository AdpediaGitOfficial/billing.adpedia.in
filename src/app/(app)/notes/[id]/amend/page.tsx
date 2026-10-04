import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR } from '@/lib/money'
import { previewNoteAmendment } from '@/server/services/tax/gst-note-amendment'
import { PageHeader, Card, Alert, Pill } from '@/components/ui/kit'
import { AmendNoteForm } from './form'

export default async function AmendNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const note = await prisma.creditNote.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { invoice: { select: { number: true } } },
  })
  if (!note) notFound()

  const today = new Date().toISOString().slice(0, 10)
  let p
  try {
    p = await previewNoteAmendment(ctx, { noteId: id, date: today, reason: 'preview' })
  } catch (e) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageHeader title="Amend" sub={note.number} />
        <Alert tone="critical" title="This note cannot be amended">
          {e instanceof Error ? e.message : 'Unknown problem'}
        </Alert>
      </div>
    )
  }

  const isCredit = p.noteType === 'CREDIT'

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={`Amend ${note.number}`}
        sub={`${isCredit ? 'Credit' : 'Debit'} note${p.againstInvoice ? ` against ${p.againstInvoice}` : ''} · filed in ${p.originalPeriod}`} />

      <Alert tone="info" title="The note itself is never edited">
        s.37(3) corrects it by reporting the revised particulars in a later return, against the original
        number and date. The original stays exactly as filed — the client holds a copy and the portal has
        it — and table 9C carries what it should have said.
      </Alert>

      {/* 🔴 docs/66 — the two deadlines, which are different statutes answering different
          questions. s.37(3) says when it may be reported; s.34(2) says whether the relief is
          available at all, and only a credit note has one. */}
      <Card className="p-4">
        <p className="eyebrow">The deadlines</p>
        <div className="mt-2 space-y-1.5 text-[12.5px]">
          <p className="flex flex-wrap items-center gap-2">
            <Pill tone={p.withinReportingDeadline ? 'good' : 'critical'} dot>s.37(3)</Pill>
            Reportable until {p.reportingDeadline.toISOString().slice(0, 10)} — 30 November following the
            financial year the note is in.
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <Pill tone={!isCredit ? 'neutral' : p.withinCreditDeadline ? 'good' : 'critical'} dot>s.34(2)</Pill>
            {isCredit && p.creditDeadline
              ? `The credit may only be increased until ${p.creditDeadline.toISOString().slice(0, 10)} — 30 November following the financial year of the INVOICE, not of the note.`
              : 'A debit note has no time limit at all — s.34(3) imposes none, and increasing one is the department’s gain.'}
          </p>
        </div>
      </Card>

      {p.refusal && <Alert tone="critical" title="This amendment cannot be made">{p.refusal}</Alert>}

      {/* 🔴 ONE alert, not one per warning.
          Three boxes stacked under the identical heading "Before you do" is the docs/60
          lesson in miniature — a reader scrolls past the third, and the third is sometimes
          the one that matters. And "nothing is different" is dropped here: this preview runs
          before the form has been touched, so of course nothing is. It still fires on submit,
          where it means something. */}
      {(() => {
        const shown = p.warnings.filter((w) => !w.startsWith('Nothing is different'))
        if (shown.length === 0) return null
        return (
          <Alert tone="warn" title={shown.length === 1 ? 'Before you do' : `${shown.length} things to know first`}>
            {shown.length === 1 ? shown[0] : (
              <ul className="ml-4 list-disc space-y-1">{shown.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
          </Alert>
        )
      })()}

      <Card className="p-4">
        <p className="eyebrow">As filed</p>
        <dl className="mt-2 text-[13px]">
          <Row k="Taxable value" v={formatINR(p.original.taxableValue)} />
          {p.original.cgst.gt(0) && <Row k="CGST" v={formatINR(p.original.cgst)} />}
          {p.original.sgst.gt(0) && <Row k="SGST" v={formatINR(p.original.sgst)} />}
          {p.original.igst.gt(0) && <Row k="IGST" v={formatINR(p.original.igst)} />}
          <Row k="Total" v={formatINR(p.original.grandTotal)} strong />
        </dl>
      </Card>

      {!p.refusal && (
        <Card className="p-4">
          <p className="eyebrow">Amend it</p>
          <div className="mt-3">
            <AmendNoteForm noteId={id} today={today} taxableValue={p.original.taxableValue.toFixed(2)} />
          </div>
        </Card>
      )}
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 border-t py-2 ${strong ? 'font-semibold' : ''}`} style={{ borderColor: 'var(--rule)' }}>
      <dt style={strong ? undefined : { color: 'var(--text-muted)' }}>{k}</dt>
      <dd className="tabular">{v}</dd>
    </div>
  )
}
