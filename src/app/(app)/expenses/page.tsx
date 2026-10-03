import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listExpenses, expensesWithoutEvidence } from '@/server/services/purchases/expense'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Pill, Empty, Button, Alert, DataTable, type Column } from '@/components/ui/kit'
import { formatINR as inr } from '@/lib/money'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { cancelExpenseAction } from './actions'

export default async function ExpensesPage() {
  const ctx = await requireContext()
  const expenses = await listExpenses(ctx)
  const live = expenses.filter((e) => !e.cancelledAt)
  const missing = await expensesWithoutEvidence(ctx)
  const noEvidence = new Set(missing.rows.map((r) => r.id))

  type Row = (typeof expenses)[number]
  const cols: Column<Row>[] = [
    { key: 'desc', header: 'Description', mobile: 'primary',
      cell: (r) => (
        <>
          {/* 🔴 the LINK is the description, not the row. This table's last column holds the
              reverse button, and a row-wide anchor wraps every cell — so clicking "cancel"
              navigated away instead of asking why. */}
          <span className="block font-medium"
            style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            <Link href={`/expenses/${r.id}`} className="hover:underline">{r.description}</Link>
            {/* docs/59 — the claim and its evidence were in different places until now */}
            {!r.cancelledAt && noEvidence.has(r.id) && (
              <span className="ml-2 align-middle"><Pill tone="warn">no bill</Pill></span>
            )}
          </span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.category.name}{r.project && ` · ${r.project.name}`}
          </span>
        </>
      ) },
    { key: 'date', header: 'Date', width: '12%', mobile: 'secondary',
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    { key: 'itc', header: 'Input credit', width: '20%', align: 'center', mobile: 'tag',
      cell: (r) => Number(r.cgst) + Number(r.sgst) + Number(r.igst) === 0
        ? <span style={{ color: 'var(--text-muted)' }}>no GST</span>
        : r.itcEligible
          ? <Pill tone="good" dot>claimable</Pill>
          : <Pill tone="critical" dot>blocked</Pill> },
    { key: 'paid', header: 'Paid from', width: '14%', align: 'center', mobile: false,
      cell: (r) => <Pill tone="neutral">{r.paidFrom.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'total', header: 'Total', width: '14%', align: 'right', mobile: 'value',
      cell: (r) => (
        <span className="font-semibold" style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
          {formatINR(r.total.toString())}
        </span>
      ) },
    // 🔴 An expense captured twice from a phone used to be uncorrectable, and it had already
    // claimed input credit — so the claim stood in the GST position with nothing able to undo it.
    { key: 'undo', header: '', width: '10%', align: 'right', mobile: false,
      cell: (r) => r.cancelledAt
        ? <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>cancelled</span>
        : <ReverseButton action={cancelExpenseAction} idName="expenseId" id={r.id}
            prompt={`Why is "${r.description}" being reversed?`} /> },
  ]

  return (
    <div>
      <PageHeader title="Expenses"
        sub={`${live.length} recorded${expenses.length > live.length ? ` · ${expenses.length - live.length} cancelled` : ''}`}
        action={<Link href="/expenses/new"><Button icon="Plus">New expense</Button></Link>} />

      {missing.itcAtRisk.gt(0) && (
        <div className="mb-4">
          <Alert tone="critical" title={`${inr(missing.itcAtRisk)} of input credit has no bill behind it`}>
            Rule 36(1) makes input credit claimable against a tax invoice you hold. {missing.rows.filter((r) => r.itc.gt(0)).length} of
            these expenses claim credit with nothing attached — open each and attach the bill.
          </Alert>
        </div>
      )}
      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={expenses} keyOf={(r) => r.id}
          empty={<Empty icon="CreditCard" title="No expenses yet"
            hint="Input credit eligibility follows the category — food, cabs and out-of-state hotels are blocked under s.17(5), and overriding needs a reason."
            action={<Link href="/expenses/new"><Button>Record the first expense</Button></Link>} />} />
      </Card>
    </div>
  )
}
