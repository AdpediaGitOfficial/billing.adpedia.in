'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { approveBill } from '@/server/services/purchases/bill'
import { AppError } from '@/server/errors'

export async function approveBillAction(_prev: { error?: string; ok?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const billId = String(formData.get('billId') ?? '')
  if (!billId) return { error: 'No bill selected' }

  try {
    await approveBill(ctx, billId)
  } catch (e) {
    // the TDS resolver throws here when a threshold has been crossed retrospectively or a
    // PAN is missing — surface it rather than swallowing it, because that IS the decision
    return { error: e instanceof AppError ? e.message : 'Could not approve that bill' }
  }
  revalidatePath('/approvals')
  revalidatePath('/bills')
  return { ok: 'Approved' }
}
