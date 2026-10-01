'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { createChallan } from '@/server/services/tax/tds-challan'
import { AppError } from '@/server/errors'

const Schema = z.object({
  sectionCode: z.string().min(3),
  quarter: z.coerce.number().int().min(1).max(4),
  deductionIds: z.string(),
  bsrCode: z.string(),
  challanSerial: z.string(),
  depositedOn: z.string(),
  interest: z.string().optional(),
  lateFee: z.string().optional(),
})

export async function createChallanAction(_prev: { error?: string; ok?: boolean } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  try {
    await createChallan(ctx, { ...parsed.data, deductionIds: JSON.parse(parsed.data.deductionIds) })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record the challan' }
  }
  revalidatePath('/tax/tds'); revalidatePath('/bills'); revalidatePath('/dashboard')
  return { ok: true }
}
