import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listExpenses } from '@/server/services/purchases/expense'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Pill, Empty, Button, DataTable, type Column } from '@/components/ui/kit'

export default async function ExpensesPage() {
  const ctx = await requireContext()
  const expenses = await listExpenses(ctx)

  type Row = (typeof expenses)[number]
  const cols: Column<Row>[] = [
    { key: 'desc', header: 'Description', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.description}</span>
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
      cell: (r) => <span className="font-semibold">{formatINR(r.total.toString())}</span> },
  ]

  return (
    <div>
      <PageHeader title="Expenses" sub={`${expenses.length} recorded`}
        action={<Link href="/expenses/new"><Button icon="Plus">New expense</Button></Link>} />
      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={expenses} keyOf={(r) => r.id}
          empty={<Empty icon="CreditCard" title="No expenses yet"
            hint="Input credit eligibility follows the category — food, cabs and out-of-state hotels are blocked under s.17(5), and overriding needs a reason."
            action={<Link href="/expenses/new"><Button>Record the first expense</Button></Link>} />} />
      </Card>
    </div>
  )
}
