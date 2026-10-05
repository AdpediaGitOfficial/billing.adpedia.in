'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { setTaxEstimate, recordAdvanceTax } from '@/server/services/tax/advance-tax'
import { cancelAdvanceTaxPayment } from '@/server/services/accounting/corrections'
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

/**
 * 🔴 docs/80 — the caller `docs/72 §5` wrote the service for and then did not add.
 *
 * That module's own argument was that a modelled-but-unserviced field is the same gap as a
 * service with no caller, and it closed the first by opening the second: the service and its
 * tests landed, the button did not, and a challan entered from the wrong counterfoil could not
 * be corrected from the screen that shows it.
 */
export async function cancelAdvanceTaxAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await cancelAdvanceTaxPayment(ctx, String(form.get('paymentId') ?? ''), String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that payment' }
  }
  revalidatePath('/tax/advance')
  revalidatePath('/tax/calendar')
  return { ok: 'Cancelled and reversed' }
}
