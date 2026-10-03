'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { recordChase } from '@/server/services/compliance/chases'
import { AppError } from '@/server/errors'

const Schema = z.object({
  kind: z.enum(['PAN_CARD', 'PAN_NUMBER', 'FORM_16A', 'INVOICE_OVERDUE', 'TDS_CREDIT']),
  subjectId: z.string().min(1),
  partyName: z.string().min(1),
  sentTo: z.string().min(3, 'Say where it was sent'),
  channel: z.enum(['EMAIL', 'WHATSAPP', 'PHONE', 'OTHER']),
  message: z.string().min(1),
  note: z.string().optional(),
})

export async function recordChaseAction(
  _prev: { error?: string; ok?: string } | null, formData: FormData,
) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    await recordChase(ctx, parsed.data)
    revalidatePath('/chases')
    return { ok: `Recorded — ${parsed.data.partyName} was asked on ${new Date().toISOString().slice(0, 10)}.` }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that' }
  }
}
