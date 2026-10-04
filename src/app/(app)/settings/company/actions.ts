'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { updateCompanyProfile } from '@/server/services/company/profile'
import { AppError } from '@/server/errors'
import { recordRocDates } from '@/server/services/compliance/roc'

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

/**
 * Record the AGM and the two filings that run from it — docs/72.
 *
 * 🔴 An empty field CLEARS the date rather than leaving it alone. A date entered by mistake has
 * to be removable, and "blank means no change" would make a wrong AGM date permanent — which
 * matters more here than almost anywhere, because both filing deadlines are derived from it.
 */
export async function recordRocDatesAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await recordRocDates(ctx, {
      financialYearId: String(form.get('financialYearId') ?? ''),
      agmHeldOn: String(form.get('agmHeldOn') ?? '') || null,
      agmSource: String(form.get('agmSource') ?? ''),
      aoc4FiledOn: String(form.get('aoc4FiledOn') ?? '') || null,
      mgt7FiledOn: String(form.get('mgt7FiledOn') ?? '') || null,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save those dates' }
  }
  revalidatePath('/settings/company')
  revalidatePath('/tax/calendar')
  return { ok: 'Saved' }
}
