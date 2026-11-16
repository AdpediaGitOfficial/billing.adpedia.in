'use server'
import { z } from 'zod'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { recordNoteAmendment } from '@/server/services/tax/gst-note-amendment'
import { AppError } from '@/server/errors'

const Schema = z.object({
  noteId: z.string().min(1),
  date: z.string().min(8, 'Pick the date this amendment is reported'),
  taxableValue: z.string().optional(),
  reason: z.string().min(5, 'An amendment is reported in GSTR-1 and read by the client — say why'),
})

export async function amendNoteAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  let invoiceId: string | null = null
  try {
    const a = await recordNoteAmendment(ctx, parsed.data)
    const note = await (await import('@/server/db')).prisma.creditNote.findUnique({
      where: { id: a.noteId, companyId: ctx.companyId }, select: { invoiceId: true },
    })
    invoiceId = note?.invoiceId ?? null
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that amendment' }
  }

  revalidatePath('/tax/gst')
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`)
  redirect(invoiceId ? `/invoices/${invoiceId}` : '/invoices')
}
