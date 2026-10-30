import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { BillForm } from './form'

export default async function NewBillPage() {
  const ctx = await requireContext()
  const [vendors, projects, accounts] = await Promise.all([
    prisma.vendor.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true, gstin: true, pan: true, panVerified: true, rcmApplicable: true, defaultTdsSection: true } }),
    prisma.project.findMany({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.account.findMany({ where: { companyId: ctx.companyId, type: 'EXPENSE' }, orderBy: { code: 'asc' }, select: { code: true, name: true } }),
  ])
  return (
    <div className="max-w-3xl">
      <PageHeader back={{ href: '/bills', label: 'Bills' }} title="New vendor bill" sub="TDS, reverse charge and input credit are computed as you type." />
      <BillForm vendors={vendors} projects={projects} accounts={accounts} />
    </div>
  )
}
