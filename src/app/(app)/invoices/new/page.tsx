import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { InvoiceForm } from './form'

export default async function NewInvoicePage() {
  const ctx = await requireContext()
  const [customers, projects, items] = await Promise.all([
    prisma.customer.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true, stateCode: true, defaultTdsSection: true } }),
    prisma.project.findMany({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' },
      select: { id: true, name: true, customerId: true } }),
    prisma.serviceItem.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
      select: { id: true, name: true, sacCode: true, defaultRate: true } }),
  ])

  return (
    <div className="max-w-3xl">
      <PageHeader back={{ href: '/invoices', label: 'Invoices' }} title="New invoice" sub="Tax mode and totals are computed as you type — nothing here is typed by hand." />
      <InvoiceForm
        customers={customers}
        projects={projects}
        items={items.map((i) => ({ ...i, defaultRate: i.defaultRate?.toString() ?? null }))}
      />
    </div>
  )
}
