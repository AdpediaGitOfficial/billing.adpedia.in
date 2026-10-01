'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { addLut } from '@/server/services/invoicing/lut'
import { AppError } from '@/server/errors'

const Schema = z.object({
  arn: z.string().min(10, 'Enter the ARN'),
  fyLabel: z.string().regex(/^\d{4}-\d{2}$/, 'Financial year looks like 2026-27'),
  filedOn: z.string().optional(),
})

export async function addLutAction(_prev: { error?: string; ok?: boolean } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  try {
    await addLut(ctx, parsed.data)
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the LUT' }
  }
  revalidatePath('/settings/lut')
  revalidatePath('/tax/gst')
  revalidatePath('/dashboard')
  return { ok: true }
}
