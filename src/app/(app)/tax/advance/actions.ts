'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { setTaxEstimate, recordAdvanceTax } from '@/server/services/tax/advance-tax'
import { AppError } from '@/server/errors'

export async function setEstimateAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await setTaxEstimate(ctx, {
      financialYearId: String(form.get('financialYearId') ?? ''),
      estimatedAnnualTax: String(form.get('estimatedAnnualTax') ?? ''),
      source: String(form.get('source') ?? ''),
      note: String(form.get('note') ?? ''),
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that estimate' }
  }
  revalidatePath('/tax/advance')
  revalidatePath('/tax/calendar')
  return { ok: 'Recorded' }
}

export async function recordAdvanceTaxAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await recordAdvanceTax(ctx, {
      paidOn: String(form.get('paidOn') ?? ''),
      amount: String(form.get('amount') ?? ''),
      bsrCode: String(form.get('bsrCode') ?? ''),
      challanSerial: String(form.get('challanSerial') ?? ''),
      note: String(form.get('note') ?? ''),
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that payment' }
  }
  revalidatePath('/tax/advance')
  revalidatePath('/tax/calendar')
  return { ok: 'Recorded' }
}
