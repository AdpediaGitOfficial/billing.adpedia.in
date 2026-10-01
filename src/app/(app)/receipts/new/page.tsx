import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import { PageHeader, Card, Empty } from '@/components/ui/kit'
import { ReceiptForm } from './form'

export default async function NewReceiptPage() {
  const ctx = await requireContext()

  const [invoices, banks] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId: ctx.companyId, status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] } },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { date: 'asc' },
    }),
    prisma.companyBankAccount.findMany({
      where: { companyId: ctx.companyId }, orderBy: { isDefault: 'desc' },
      select: { id: true, label: true, isDefault: true },
    }),
  ])

  const open = invoices.flatMap((i) => {
    const settled = new Decimal(i.amountReceived.toString()).plus(i.tdsCredited.toString())
    const outstanding = new Decimal(i.grandTotal.toString()).minus(settled)
    if (outstanding.lte(0)) return []
    // what the client is still expected to withhold on this invoice
    const tdsExpected = Decimal.max(
      new Decimal(i.tdsAmount.toString()).minus(i.tdsCredited.toString()), ZERO)
    return [{
      id: i.id, number: i.number,
      customerId: i.customer.id, customerName: i.customer.name,
      date: i.date.toISOString().slice(0, 10),
      dueDate: i.dueDate.toISOString().slice(0, 10),
      outstanding: outstanding.toFixed(2),
      tdsExpected: tdsExpected.toFixed(2),
      tdsSection: i.tdsSection,
    }]
  })

  if (open.length === 0) {
    return (
      <div className="max-w-2xl space-y-5">
        <PageHeader title="Record a receipt" />
        <Card><Empty icon="Receipt" title="Nothing is outstanding"
          hint="A receipt is allocated against an invoice, and every invoice is settled. Send one first." /></Card>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="Record a receipt"
        sub="For money that did not come through a bank line — a cheque, cash, or a payment you are booking ahead of the statement." />
      <ReceiptForm invoices={open} banks={banks} />
    </div>
  )
}
