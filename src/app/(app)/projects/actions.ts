'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { assertCan } from '@/server/auth/permissions'

const Schema = z.object({
  customerId: z.string().min(1, 'Pick a client'),
  code: z.string().min(2, 'Give the project a short code').max(24)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only — the code appears on reports'),
  name: z.string().min(2, 'Give the project a name'),
  contractValue: z.string().optional(),
  startsOn: z.string().optional(),
})

export async function createProjectAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  assertCan(ctx.role, 'projects', 'write')

  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const v = parsed.data
  const code = v.code.toUpperCase()

  // the code is unique per company and appears on every project report, so a clash has to
  // be reported rather than silently suffixed
  const clash = await prisma.project.findFirst({ where: { companyId: ctx.companyId, code } })
  if (clash) return { error: `A project already uses the code ${code} — ${clash.name}` }

  const project = await prisma.project.create({
    data: {
      companyId: ctx.companyId, customerId: v.customerId, code, name: v.name,
      contractValue: v.contractValue ? v.contractValue : null,
      startsOn: v.startsOn ? new Date(v.startsOn) : null,
      status: 'ACTIVE',
    },
  })
  revalidatePath('/projects')
  redirect(`/projects?created=${project.code}`)
}

export async function setProjectStatusAction(_prev: unknown, formData: FormData) {
  const ctx = await requireContext()
  assertCan(ctx.role, 'projects', 'write')
  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? '')
  if (!['PROSPECT', 'ACTIVE', 'COMPLETED', 'ON_HOLD', 'CANCELLED'].includes(status)) return { error: 'Unknown status' }

  await prisma.project.updateMany({ where: { id, companyId: ctx.companyId }, data: { status: status as never } })
  revalidatePath('/projects')
  return { ok: true }
}
