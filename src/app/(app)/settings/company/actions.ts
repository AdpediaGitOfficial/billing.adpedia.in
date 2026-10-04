'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { updateCompanyProfile } from '@/server/services/company/profile'
import { AppError } from '@/server/errors'

const Schema = z.object({
  tradeName: z.string().optional(),
  tan: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  addressLine1: z.string().min(1, 'The registered address needs a first line'),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  country: z.string().optional(),
})

export async function saveCompanyAction(
  _prev: { error?: string; ok?: string } | null, form: FormData,
) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    await updateCompanyProfile(ctx, parsed.data)
    revalidatePath('/settings/company')
    return {
      ok: 'Saved. Documents already issued keep the details they were issued with — each is held as the ' +
        'exact file that went out, so nothing behind you has changed.',
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save those details' }
  }
}
