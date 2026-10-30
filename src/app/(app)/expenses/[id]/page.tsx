import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, Pill, Alert } from '@/components/ui/kit'
import { listAttachments } from '@/server/services/storage/attachment'
import { AttachmentPanel } from '@/components/attachments/attachment-panel'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelExpenseAction } from '../actions'

export default async function ExpenseDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const expense = await prisma.expense.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { category: true, project: { select: { name: true } } },
  })
  if (!expense) notFound()

  const attachments = await listAttachments(ctx, 'Expense', expense.id)
  const itc = new Decimal(expense.cgst.toString())
    .plus(expense.sgst.toString()).plus(expense.igst.toString())
  const claiming = expense.itcEligible && itc.gt(0)

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title={expense.description}
        sub={`${expense.category.name}${expense.project ? ` · ${expense.project.name}` : ''} · ${expense.date.toISOString().slice(0, 10)}`}
        back={{ href: '/expenses', label: 'Expenses' }} />

      {expense.cancelledAt && (
        <Alert tone="info" title="This expense has been reversed">
          {expense.cancelReason ?? 'No reason was recorded.'} It stays on file; the ledger entry behind it
          has been reversed.
        </Alert>
      )}

      {/* 🔴 docs/59 — the claim and its evidence finally live in the same place. Rule 36(1)
          makes input credit claimable against a tax invoice the recipient HOLDS. */}
      {claiming && attachments.length === 0 && (
        <Alert tone="critical" title={`${formatINR(itc)} of input credit with nothing behind it`}>
          Rule 36(1) makes the credit claimable against a tax invoice you hold. Until the bill is
          attached here, this claim cannot be sustained if it is ever asked about — and the money has
          already been taken against the GST payable.
        </Alert>
      )}

      <AttachmentPanel
        entityType="Expense" entityId={expense.id} kind="RECEIPT"
        title="The bill"
        hint={claiming
          ? 'A photo or PDF of the supplier’s tax invoice. It is what substantiates the input credit above.'
          : 'A photo or PDF of the bill. No input credit is being claimed, but it still substantiates the deduction.'}
        initial={attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes }))} />

      {/* 🔴 docs/68 §5 — this was only on the expenses table, in a column the mobile card
          dropped. Anyone on a phone could see a duplicate capture and had no way to reverse
          it, and this page, which is where they would come looking, did not offer it either. */}
      {!expense.cancelledAt && (
        <Card>
          <CardHeader title="Reverse this expense" className="mb-3"
            sub="Posts a reversing entry and puts back the input credit it claimed. Nothing is deleted — both entries stay, and the reason is the only record of why." />
          <ReverseButton action={cancelExpenseAction} idName="expenseId" id={expense.id}
            label="reverse it" prompt={`Why is "${expense.description}" being reversed?`} />
        </Card>
      )}

      <Card flush className="overflow-hidden">
        <CardHeader title="The expense" className="p-5 pb-3" sub={`Paid from ${expense.paidFrom.replace('_', ' ').toLowerCase()}`} />
        <dl className="px-5 pb-4 text-[13px]">
          <Row k="Taxable value" v={formatINR(expense.taxableValue.toString())} />
          {Number(expense.cgst) > 0 && <Row k="CGST" v={formatINR(expense.cgst.toString())} />}
          {Number(expense.sgst) > 0 && <Row k="SGST" v={formatINR(expense.sgst.toString())} />}
          {Number(expense.igst) > 0 && <Row k="IGST" v={formatINR(expense.igst.toString())} />}
          <Row k="Total" v={formatINR(expense.total.toString())} strong />
        </dl>
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          {itc.isZero()
            ? <Pill tone="neutral">no GST on this expense</Pill>
            : expense.itcEligible
              ? <Pill tone="good" dot>{formatINR(itc)} input credit claimed</Pill>
              : <Pill tone="critical" dot>credit blocked{expense.itcBlockedReason ? ` — ${expense.itcBlockedReason}` : ''}</Pill>}
          {expense.isRcm && <Pill tone="warn">reverse charge</Pill>}
        </div>
      </Card>
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
