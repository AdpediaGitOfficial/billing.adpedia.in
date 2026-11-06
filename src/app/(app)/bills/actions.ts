'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createBill, approveBill, payBill, cancelBill } from '@/server/services/purchases/bill'
import { cancelBillPayment } from '@/server/services/accounting/corrections'
import { AppError } from '@/server/errors'

const LineSchema = z.object({
  description: z.string().min(1),
  sacCode: z.string().optional(),
  quantity: z.string().default('1'),
  rate: z.string(),
  gstRatePct: z.string().default('18'),
  expenseAccountCode: z.string().default('5200'),
})

const Schema = z.object({
  vendorId: z.string().min(1, 'Pick a vendor'),
  projectId: z.string().optional(),
  billNumber: z.string().min(1, "Enter the vendor's bill number"),
  billDate: z.string().min(1),
  // docs/93 — the currency the vendor billed in and the rate it is booked at; absent for rupees
  currency: z.string().optional(),
  fxRate: z.string().optional(),
  lines: z.string(),
})

export async function createBillAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  let lines: z.infer<typeof LineSchema>[]
  try {
    lines = z.array(LineSchema).min(1).parse(JSON.parse(parsed.data.lines))
  } catch {
    return { error: 'Add at least one line with a description and an amount' }
  }

  let id: string
  try {
    const bill = await createBill(ctx, {
      ...parsed.data, projectId: parsed.data.projectId || undefined,
      currency: parsed.data.currency || undefined, fxRate: parsed.data.fxRate || undefined, lines,
    })
    id = bill.id
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not create the bill' }
  }
  revalidatePath('/bills')
  redirect(`/bills/${id}`)
}

export async function approveBillAction(billId: string) {
  const ctx = await requireContext()
  try {
    await approveBill(ctx, billId)
    revalidatePath('/bills'); revalidatePath(`/bills/${billId}`); revalidatePath('/tax/gst')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not approve the bill' }
  }
}

export async function payBillAction(billId: string, amount: string, date: string, reference?: string, inrAmount?: string) {
  const ctx = await requireContext()
  try {
    await payBill(ctx, { billId, amount, date, mode: 'NEFT', reference, inrAmount: inrAmount || undefined })
    revalidatePath('/bills'); revalidatePath(`/bills/${billId}`)
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not record the payment' }
  }
}

export async function cancelBillAction(billId: string, reason: string) {
  const ctx = await requireContext()
  try {
    await cancelBill(ctx, billId, reason)
    revalidatePath('/bills'); revalidatePath(`/bills/${billId}`)
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not cancel the bill' }
  }
}

/**
 * Reverse a payment made against a bill — docs/49.
 *
 * The service has existed since docs/40 and nothing could call it: a payment entered twice,
 * or against the wrong bill, could be corrected only in the database.
 */
export async function cancelBillPaymentAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const id = String(form.get('paymentId') ?? '')
  const reason = String(form.get('reason') ?? '')
  try {
    await cancelBillPayment(ctx, id, reason)
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that payment' }
  }
  revalidatePath('/bills')
  revalidatePath('/banking/reconcile')
  return { ok: 'Cancelled and reversed' }
}
