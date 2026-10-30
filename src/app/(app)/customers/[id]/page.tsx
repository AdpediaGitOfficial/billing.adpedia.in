import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { EditCustomerForm } from './form'

interface Addr { line1?: string; line2?: string; city?: string; pincode?: string }

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const customer = await prisma.customer.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { _count: { select: { invoices: true } } },
  })
  if (!customer) notFound()

  // 🔴 how many invoices have already been ISSUED to them — the number that decides whether
  // a change to the state code or GSTIN deserves a warning
  const issued = await prisma.invoice.count({
    where: { companyId: ctx.companyId, customerId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
  })
  const addr = (customer.billingAddress ?? {}) as Addr

  return (
    <div className="max-w-2xl">
      <PageHeader back={{ href: '/customers', label: 'Customers' }} title={customer.name} sub="Tax treatment is derived from the country and state — you never pick it." />
      <EditCustomerForm
        issuedInvoices={issued}
        customer={{
          id: customer.id, name: customer.name,
          contactPerson: customer.contactPerson ?? '', email: customer.email ?? '', phone: customer.phone ?? '',
          country: customer.country, stateCode: customer.stateCode ?? '',
          gstin: customer.gstin ?? '', pan: customer.pan ?? '',
          paymentTermDays: customer.paymentTermDays,
          defaultTdsSection: customer.defaultTdsSection ?? '',
          line1: addr.line1 ?? '', line2: addr.line2 ?? '', city: addr.city ?? '', pincode: addr.pincode ?? '',
        }} />
    </div>
  )
}
