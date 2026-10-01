'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createVendor } from '@/server/services/purchases/vendor'
import { AppError } from '@/server/errors'

const Schema = z.object({
  name: z.string().min(2, 'Name is required'),
  vendorType: z.enum(['FREELANCER', 'SUBCONTRACTOR', 'AGENCY', 'SUPPLIER', 'UTILITY', 'CLOUD', 'PROFESSIONAL', 'OTHER']),
  email: z.string().email().or(z.literal('')).optional(),
  phone: z.string().optional(),
  country: z.string().default('IN'),
  stateCode: z.string().optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  defaultTdsSection: z.string().optional(),
  paymentTermDays: z.coerce.number().int().min(0).max(180).default(15),
})

export async function createVendorAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const d = parsed.data
  try {
    await createVendor(ctx, {
      ...d,
      email: d.email || undefined,
      stateCode: d.stateCode || null,
      gstin: d.gstin || null,
      pan: d.pan || null,
      defaultTdsSection: d.defaultTdsSection || null,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the vendor' }
  }
  revalidatePath('/vendors')
  redirect('/vendors')
}
