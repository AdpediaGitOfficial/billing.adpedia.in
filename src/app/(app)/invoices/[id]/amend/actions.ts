'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { recordAmendment } from '@/server/services/tax/gst-amendment'
import { AppError } from '@/server/errors'

export async function amendInvoiceAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const invoiceId = String(form.get('invoiceId') ?? '')
  try {
    await recordAmendment(ctx, {
      invoiceId,
      date: String(form.get('date') ?? ''),
      reason: String(form.get('reason') ?? ''),
      gstin: String(form.get('gstin') ?? '') || undefined,
      stateCode: String(form.get('stateCode') ?? '') || undefined,
      taxableValue: String(form.get('taxableValue') ?? '') || undefined,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that amendment' }
  }
  revalidatePath('/invoices'); revalidatePath(`/invoices/${invoiceId}`); revalidatePath('/tax/gst')
  redirect(`/invoices/${invoiceId}`)
}
