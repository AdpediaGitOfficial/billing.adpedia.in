'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { createChallan } from '@/server/services/tax/tds-challan'
import { cancelTdsChallan } from '@/server/services/accounting/corrections'
import { recordTdsFiling } from '@/server/services/tax/tds-filing'
import type { ReturnForm } from '@/server/services/tax/tds-return'
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

/**
 * Record a quarterly return as filed — docs/50.
 *
 * 🔴 It is what every cancellation guard in this module reads. Recording it wrongly is how a
 * deduction that is already in somebody's 26AS gets reversed here.
 */
export async function recordTdsFilingAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    const row = await recordTdsFiling(ctx, {
      formType: String(form.get('formType') ?? '26Q') as ReturnForm,
      quarter: Number(form.get('quarter') ?? 1) as 1 | 2 | 3 | 4,
      filedOn: String(form.get('filedOn') ?? ''),
      token: String(form.get('token') ?? '') || undefined,
    })
    revalidatePath('/tax/tds'); revalidatePath('/tax/calendar')
    return {
      ok: `${row.formType} for Q${row.quarter} recorded as filed. ` +
        'The payroll runs and challans behind it can no longer be reversed here.',
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that filing' }
  }
}

export async function cancelChallanAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await cancelTdsChallan(ctx, String(form.get('challanId') ?? ''), String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that challan' }
  }
  revalidatePath('/tax/tds'); revalidatePath('/tax/calendar'); revalidatePath('/dashboard')
  return { ok: 'Cancelled — the deductions are outstanding again' }
}
