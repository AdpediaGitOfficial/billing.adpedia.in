'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { createServiceItem, updateServiceItem, setServiceItemActive } from '@/server/services/invoicing/service-item'
import { AppError } from '@/server/errors'

const Schema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, 'A service needs a name'),
  sacCode: z.string().optional(),
  defaultRate: z.string().optional(),
  gstRatePct: z.string().optional(),
  incomeAccountId: z.string().optional(),
})

export async function saveServiceItemAction(
  _prev: { error?: string; ok?: string } | null, form: FormData,
) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const { id, ...input } = parsed.data
  try {
    const item = id
      ? await updateServiceItem(ctx, id, input)
      : await createServiceItem(ctx, input)
    revalidatePath('/settings/services'); revalidatePath('/invoices/new')
    return { ok: `${item.name} saved.` }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save that service' }
  }
}

export async function retireServiceItemAction(id: string, isActive: boolean) {
  const ctx = await requireContext()
  try {
    await setServiceItemActive(ctx, id, isActive)
    revalidatePath('/settings/services'); revalidatePath('/invoices/new')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not update' }
  }
}
