'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
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
