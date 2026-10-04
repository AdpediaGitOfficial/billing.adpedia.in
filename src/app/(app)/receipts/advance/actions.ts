'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createRefundVoucher } from '@/server/services/sales/refund'
import { createAdvanceReceipt, adjustAdvance } from '@/server/services/sales/advance'
import { AppError } from '@/server/errors'
import { formatINR } from '@/lib/money'

type Mode = 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'SWIFT' | 'OTHER'

export async function createAdvanceAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await createAdvanceReceipt(ctx, {
      customerId: String(form.get('customerId') ?? ''),
      date: String(form.get('date') ?? ''),
      mode: String(form.get('mode') ?? 'NEFT') as Mode,
      amount: String(form.get('amount') ?? '0'),
      tdsAmount: String(form.get('tdsAmount') ?? '') || undefined,
      gstRatePct: String(form.get('gstRatePct') ?? '') || undefined,
      reference: String(form.get('reference') ?? '') || undefined,
      description: String(form.get('description') ?? '') || undefined,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that advance' }
  }
  revalidatePath('/receipts'); revalidatePath('/tax/gst')
  redirect('/receipts')
}

/**
 * Absorb an advance into an invoice — docs/54.
 *
 * 🔴 This is what stops the supply being taxed twice: the tax the advance paid is reversed
 * here, because the invoice now declares its own.
 */
export async function adjustAdvanceAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    const r = await adjustAdvance(ctx, {
      receiptId: String(form.get('receiptId') ?? ''),
      invoiceId: String(form.get('invoiceId') ?? ''),
      amount: String(form.get('amount') ?? '0'),
      date: String(form.get('date') ?? new Date().toISOString().slice(0, 10)),
    })
    revalidatePath('/receipts'); revalidatePath('/invoices'); revalidatePath('/tax/gst')
    return {
      ok: `Adjusted ${formatINR(r.adjusted)}, reversing ${formatINR(r.taxReversed)} of tax the advance had paid.`,
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not adjust that advance' }
  }
}

const RefundSchema = z.object({
  receiptId: z.string().min(1),
  date: z.string().min(8, 'Pick the date the money went back'),
  amount: z.string().min(1, 'How much is being returned?'),
  reason: z.string().min(5, 'Rule 51 requires the reason on the voucher — say why in a few words'),
})

/**
 * Issue a refund voucher — docs/65.
 *
 * 🔴 Separate from `adjustAdvanceAction` on purpose. Adjusting an advance against an invoice
 * and giving it back are opposite outcomes, and a single form with a mode switch is how
 * somebody refunds a client who was actually invoiced.
 */
export async function refundAdvanceAction(
  _prev: { error?: string; ok?: string } | null, formData: FormData,
) {
  const ctx = await requireContext()
  const parsed = RefundSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const v = await createRefundVoucher(ctx, parsed.data)
    revalidatePath('/receipts'); revalidatePath('/tax/gst')
    return { ok: `Refund voucher ${v.number} issued — the tax on it comes back in this period's return.` }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not issue that refund voucher' }
  }
}
