'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { cancelCreditNote } from '@/server/services/accounting/corrections'
import { AppError } from '@/server/errors'

export async function createCreditNoteAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const invoiceId = String(form.get('invoiceId') ?? '')
  const full = String(form.get('scope') ?? 'partial') === 'full'

  try {
    await createCreditNote(ctx, {
      invoiceId,
      date: String(form.get('date') ?? ''),
      reason: String(form.get('reason') ?? ''),
      taxableValue: String(form.get('taxableValue') ?? '0'),
      full,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not issue that credit note' }
  }
  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  redirect(`/invoices/${invoiceId}`)
}

/**
 * Reverse a credit note — docs/51.
 *
 * Refused once the GSTR-1 that declared it has been filed: it has reached the customer's
 * GSTR-2B by then, and withdrawing it leaves them holding a reversal we no longer issue.
 */
export async function cancelCreditNoteAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await cancelCreditNote(ctx, String(form.get('noteId') ?? ''), String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that credit note' }
  }
  revalidatePath('/invoices'); revalidatePath('/tax/gst')
  return { ok: 'Cancelled and reversed' }
}
