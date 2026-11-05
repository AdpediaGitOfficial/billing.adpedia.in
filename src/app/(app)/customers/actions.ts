'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createCustomer, updateCustomer } from '@/server/services/sales/customer'
import { AppError } from '@/server/errors'
import { countryName } from '@/lib/countries'

const Schema = z.object({
  name: z.string().min(2, 'Name is required'),
  contactPerson: z.string().optional(),
  email: z.string().email().or(z.literal('')).optional(),
  phone: z.string().optional(),
  country: z.string().default('IN'),
  currency: z.string().optional(),
  stateCode: z.string().optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  paymentTermDays: z.coerce.number().int().min(0).max(180).default(15),
  defaultTdsSection: z.enum(['194J', '194C']).or(z.literal('')).optional(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  pincode: z.string().optional(),
})

export async function createCustomerAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const d = parsed.data
  try {
    await createCustomer(ctx, {
      name: d.name,
      contactPerson: d.contactPerson || undefined,
      email: d.email || undefined,
      phone: d.phone || undefined,
      country: d.country,
      currency: d.currency,
      stateCode: d.stateCode || null,
      gstin: d.gstin || null,
      pan: d.pan || null,
      customerType: d.country === 'IN' ? 'B2B' : 'EXPORT',
      paymentTermDays: d.paymentTermDays,
      defaultTdsSection: (d.defaultTdsSection || null) as '194J' | '194C' | null,
      billingAddress: { line1: d.line1, line2: d.line2, city: d.city, pincode: d.pincode, country: countryName(d.country) },
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the customer' }
  }
  revalidatePath('/customers')
  redirect('/customers')
}

export async function updateCustomerAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const id = String(formData.get('id') ?? '')
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const d = parsed.data
  try {
    await updateCustomer(ctx, id, {
      name: d.name,
      contactPerson: d.contactPerson || undefined,
      email: d.email || undefined,
      phone: d.phone || undefined,
      country: d.country,
      currency: d.currency,
      stateCode: d.stateCode || null,
      gstin: d.gstin || null,
      pan: d.pan || null,
      paymentTermDays: d.paymentTermDays,
      defaultTdsSection: d.defaultTdsSection || null,
      billingAddress: { line1: d.line1, line2: d.line2, city: d.city, state: d.stateCode, pincode: d.pincode, country: countryName(d.country) },
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save those changes' }
  }
  revalidatePath('/customers')
  redirect('/customers')
}
