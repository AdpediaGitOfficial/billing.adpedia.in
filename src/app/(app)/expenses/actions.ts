'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createExpense, BLOCKED_REASONS } from '@/server/services/purchases/expense'
import { cancelExpense } from '@/server/services/accounting/corrections'
import { AppError } from '@/server/errors'

const Schema = z.object({
  categoryId: z.string().min(1, 'Pick a category'),
  date: z.string().min(1),
  description: z.string().min(2, 'Describe the expense'),
  taxableValue: z.string().min(1),
  gstRatePct: z.string().optional(),
  gstMode: z.enum(['INTRA', 'INTER', 'NONE']).optional(),
  projectId: z.string().optional(),
  paidFrom: z.enum(['BANK', 'CASH', 'CARD', 'PERSONAL_REIMBURSABLE']).optional(),
  itcEligible: z.string().optional(),
  itcBlockedReason: z.string().optional(),
})

export async function createExpenseAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const d = parsed.data
  try {
    await createExpense(ctx, {
      ...d,
      projectId: d.projectId || undefined,
      itcEligible: d.itcEligible === 'on',
      itcBlockedReason: (d.itcBlockedReason || undefined) as keyof typeof BLOCKED_REASONS | undefined,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the expense' }
  }
  revalidatePath('/expenses'); revalidatePath('/tax/gst')
  redirect('/expenses')
}

/**
 * Reverse an expense — docs/49.
 *
 * 🔴 Also puts back the input credit it claimed. An expense captured twice from a phone was,
 * until now, uncorrectable: the claim stood in the GST position with nothing able to undo it.
 */
export async function cancelExpenseAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const id = String(form.get('expenseId') ?? '')
  const reason = String(form.get('reason') ?? '')
  try {
    await cancelExpense(ctx, id, reason)
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not cancel that expense' }
  }
  revalidatePath('/expenses')
  revalidatePath('/tax/gst')
  return { ok: 'Cancelled and reversed' }
}
