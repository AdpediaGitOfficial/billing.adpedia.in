import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader, Card, Empty } from '@/components/ui/kit'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { noteTotals } from '@/server/services/invoicing/notes'
import { ReceiptForm } from './form'

/**
 * `?invoice=` preselects the customer and settles that invoice in full — docs/68 §3. It is
 * where the invoice list's swipe lands, and it is also just the obvious thing to support
 * from any "record a receipt" link.
 *
 * 🔴 It preselects; it does not post. The amount a client actually sent is net of whatever
 * they withheld and nobody here knows that until the money lands, so the proposal is
 * `lib/settlement.ts`'s and the person still presses the button.
 */
export default async function NewReceiptPage({ searchParams }: {
  searchParams: Promise<{ invoice?: string }>
}) {
  const ctx = await requireContext()
  const { invoice: wantedInvoiceId } = await searchParams

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

  // 🔴 docs/86 — net of the credit notes against each invoice, which is the same figure the
  // service's over-allocation guard now uses. Offering the issued total here was offering an
  // amount `createReceipt` should have refused, and did not.
  const notes = await noteTotals(ctx.companyId, invoices.map((i) => i.id))

  const open = invoices.flatMap((i) => {
    const { outstanding, tdsExpected } = invoiceOpen(i, notes.get(i.id) ?? NO_NOTES)
    if (outstanding.lte(0)) return []
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
        <PageHeader back={{ href: '/receipts', label: 'Receipts' }} title="Record a receipt" />
        <Card><Empty icon="Receipt" title="Nothing is outstanding"
          hint="A receipt is allocated against an invoice, and every invoice is settled. Send one first." /></Card>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <PageHeader back={{ href: '/receipts', label: 'Receipts' }} title="Record a receipt"
        sub="For money that did not come through a bank line — a cheque, cash, or a payment you are booking ahead of the statement." />
      <ReceiptForm invoices={open} banks={banks}
        preselect={open.some((i) => i.id === wantedInvoiceId) ? wantedInvoiceId : undefined} />
    </div>
  )
}
