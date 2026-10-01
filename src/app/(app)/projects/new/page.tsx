import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { ProjectForm } from './form'

export default async function NewProjectPage() {
  const ctx = await requireContext()
  const customers = await prisma.customer.findMany({
    where: { companyId: ctx.companyId }, orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })

  return (
    <div className="max-w-xl">
      <PageHeader title="New project"
        sub="A project is how cost and revenue get grouped — tag invoices, bills and payroll to it and the margin becomes real." />
      <ProjectForm customers={customers} />
    </div>
  )
}
