import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { CaptureFlow } from './flow'

export default async function CaptureExpensePage() {
  const ctx = await requireContext()
  const [categories, projects] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId: ctx.companyId }, orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, itcDefault: true, gstTreatment: true },
    }),
    prisma.project.findMany({
      where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <div className="max-w-xl">
      <PageHeader title="Capture expense"
        sub="Photograph the receipt. Works offline — it queues and syncs when you reconnect." />
      <CaptureFlow categories={categories} projects={projects} />
    </div>
  )
}
