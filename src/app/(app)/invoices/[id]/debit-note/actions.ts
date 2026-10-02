'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createDebitNote } from '@/server/services/invoicing/debit-note'
import { AppError } from '@/server/errors'

export async function createDebitNoteAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const invoiceId = String(form.get('invoiceId') ?? '')
  try {
    await createDebitNote(ctx, {
      invoiceId,
      date: String(form.get('date') ?? ''),
      reason: String(form.get('reason') ?? ''),
      taxableValue: String(form.get('taxableValue') ?? '0'),
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not issue that debit note' }
  }
  revalidatePath('/invoices'); revalidatePath(`/invoices/${invoiceId}`); revalidatePath('/tax/gst')
  redirect(`/invoices/${invoiceId}`)
}
