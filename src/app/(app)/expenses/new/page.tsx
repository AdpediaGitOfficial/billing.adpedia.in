import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { ExpenseForm } from './form'

export default async function NewExpensePage() {
  const ctx = await requireContext()
  const [categories, projects] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, itcDefault: true, gstTreatment: true, rcmPossible: true } }),
    prisma.project.findMany({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ])
  return (
    <div className="max-w-2xl">
      <PageHeader back={{ href: '/expenses', label: 'Expenses' }} title="New expense" sub="Input credit eligibility follows the category — an override needs a reason." />
      <ExpenseForm categories={categories} projects={projects} />
    </div>
  )
}
