'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createReceipt } from '@/server/services/sales/receipt'
import { cancelReceipt, cancelRefundVoucher } from '@/server/services/accounting/corrections'
import { AppError } from '@/server/errors'

const Schema = z.object({
  customerId: z.string().min(1, 'Pick a client'),
  date: z.string().min(1, 'Pick the date the money arrived'),
  mode: z.enum(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'SWIFT', 'OTHER']),
  reference: z.string().optional(),
  bankCharge: z.string().optional(),
  /** JSON: [{ invoiceId, amount, tdsAmount }] */
  allocations: z.string(),
})

export async function createReceiptAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  let allocations: { invoiceId: string; amount: string; tdsAmount?: string }[]
  try {
    allocations = JSON.parse(parsed.data.allocations)
  } catch {
    return { error: 'Could not read the allocations' }
  }

  // drop untouched rows — the form sends one per open invoice
  const used = allocations.filter((a) => Number(a.amount) > 0 || Number(a.tdsAmount ?? 0) > 0)
  if (used.length === 0) return { error: 'Allocate the receipt to at least one invoice' }

  try {
    await createReceipt(ctx, {
      customerId: parsed.data.customerId,
      date: parsed.data.date,
      mode: parsed.data.mode,
      reference: parsed.data.reference || undefined,
      bankCharge: parsed.data.bankCharge || undefined,
      allocations: used,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that receipt' }
  }

  revalidatePath('/receipts')
  revalidatePath('/invoices')
  redirect('/receipts')
}

export async function cancelReceiptAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const id = String(form.get('receiptId') ?? '')
  const reason = String(form.get('reason') ?? '')
  try {
    await cancelReceipt(ctx, id, reason)
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that receipt' }
  }
  revalidatePath('/receipts')
  revalidatePath('/invoices')
  return { ok: 'Cancelled and reversed' }
}

/**
 * Cancel a refund voucher — docs/69.
 *
 * The last member of docs/51's family to get a button. It was modelled for since docs/65 and
 * had no service; the service could not be written while the voucher's journal entry was
 * filed under the advance's id, because nothing could find it.
 */
export async function cancelRefundVoucherAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const id = String(form.get('voucherId') ?? '')
  const reason = String(form.get('reason') ?? '')
  try {
    await cancelRefundVoucher(ctx, id, reason)
  } catch (e) {
    // the GSTR-1 refusal IS the decision — show it in full rather than reducing it
    return { error: e instanceof AppError ? e.message : 'Could not cancel that refund voucher' }
  }
  revalidatePath('/receipts')
  revalidatePath('/tax/gst')
  return { ok: 'Cancelled and reversed' }
}
