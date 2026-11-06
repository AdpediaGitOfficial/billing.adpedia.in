import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { mayCollectTax } from '@/server/services/invoicing/document-type'
import { InvoiceForm } from './form'

export default async function NewInvoicePage() {
  const ctx = await requireContext()
  // 🔴 docs/88 — decides the rate a line starts at. An entity that may not collect GST must
  // never send the hidden 18% the form used to carry.
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstRegistrationType: true },
  })
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
        canChargeGst={mayCollectTax(company.gstRegistrationType)}
        customers={customers}
        projects={projects}
        items={items.map((i) => ({ ...i, defaultRate: i.defaultRate?.toString() ?? null }))}
      />
    </div>
  )
}
