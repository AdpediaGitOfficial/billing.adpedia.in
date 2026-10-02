import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader, Alert } from '@/components/ui/kit'
import { ProjectForm } from '../../project-form'
import { updateProjectAction } from '../../actions'

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireContext()

  const [project, customers, invoiced] = await Promise.all([
    prisma.project.findFirst({ where: { id, companyId: ctx.companyId } }),
    prisma.customer.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.invoice.count({ where: { projectId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } } }),
  ])
  if (!project) notFound()

  return (
    <div className="max-w-xl space-y-4">
      <PageHeader title={`Edit ${project.code}`} sub={project.name} />

      {invoiced > 0 && (
        /* 🔴 The code is printed on the invoice document. Changing it now relabels the
           project everywhere, including on invoices the client already holds a copy of —
           which will no longer match. */
        <Alert tone="warn" title={`${invoiced} invoice${invoiced === 1 ? ' quotes' : 's quote'} this project`}>
          The project name is printed on the invoice document. Renaming it changes what this system
          reproduces for invoices already sent — the client&rsquo;s copy keeps the old name, and the two
          will not agree. Changing the <strong>client</strong> also moves the whole history into a
          different client P&amp;L.
        </Alert>
      )}

      <ProjectForm
        customers={customers}
        action={updateProjectAction}
        submitLabel="Save changes"
        busyLabel="Saving…"
        initial={{
          id: project.id,
          customerId: project.customerId,
          name: project.name,
          code: project.code,
          contractValue: project.contractValue ? project.contractValue.toString() : null,
          startsOn: project.startsOn ? project.startsOn.toISOString().slice(0, 10) : null,
        }} />
    </div>
  )
}
