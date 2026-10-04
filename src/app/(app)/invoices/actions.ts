'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireContext } from '@/server/context'
import { createInvoice, updateInvoiceDraft, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { AppError } from '@/server/errors'

const LineSchema = z.object({
  description: z.string().min(1),
  sacCode: z.string().optional(),
  quantity: z.string().default('1'),
  rate: z.string(),
  gstRatePct: z.string().default('18'),
  // docs/67 — which catalogue service this line came from, so its income account is used
  serviceItemId: z.string().nullable().optional(),
})

const Schema = z.object({
  customerId: z.string().min(1, 'Pick a customer'),
  projectId: z.string().optional(),
  date: z.string().min(1),
  customerRef: z.string().optional(),
  milestone: z.string().optional(),
  tdsSection: z.enum(['194J', '194C']).or(z.literal('')).optional(),
  lines: z.string(),
})

export async function createInvoiceAction(_prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  let lines: z.infer<typeof LineSchema>[]
  try {
    lines = z.array(LineSchema).min(1, 'Add at least one line').parse(JSON.parse(parsed.data.lines))
  } catch {
    return { error: 'Add at least one line with a description and a rate' }
  }

  let id: string
  try {
    const inv = await createInvoice(ctx, {
      customerId: parsed.data.customerId,
      projectId: parsed.data.projectId || undefined,
      date: parsed.data.date,
      customerRef: parsed.data.customerRef || undefined,
      milestone: parsed.data.milestone || undefined,
      tdsSection: (parsed.data.tdsSection || null) as '194J' | '194C' | null,
      lines,
    })
    id = inv.id
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not create the invoice' }
  }
  revalidatePath('/invoices')
  redirect(`/invoices/${id}`)
}

/**
 * Edit a draft — docs/70. Bound to the invoice id by the page, so the form's own
 * `useActionState` signature is unchanged.
 */
export async function updateInvoiceAction(invoiceId: string, _prev: { error?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  let lines: z.infer<typeof LineSchema>[]
  try {
    lines = z.array(LineSchema).min(1, 'Add at least one line').parse(JSON.parse(parsed.data.lines))
  } catch {
    return { error: 'Add at least one line with a description and a rate' }
  }

  try {
    await updateInvoiceDraft(ctx, invoiceId, {
      customerId: parsed.data.customerId,
      projectId: parsed.data.projectId || undefined,
      date: parsed.data.date,
      customerRef: parsed.data.customerRef || undefined,
      milestone: parsed.data.milestone || undefined,
      tdsSection: (parsed.data.tdsSection || null) as '194J' | '194C' | null,
      lines,
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the draft' }
  }
  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  redirect(`/invoices/${invoiceId}`)
}

export async function sendInvoiceAction(invoiceId: string) {
  const ctx = await requireContext()
  try {
    const inv = await sendInvoice(ctx, invoiceId)
    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)
    return { ok: true as const, number: inv.number }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not send the invoice' }
  }
}

export async function cancelInvoiceAction(invoiceId: string, reason: string) {
  const ctx = await requireContext()
  try {
    await cancelInvoice(ctx, invoiceId, reason)
    revalidatePath('/invoices')
    revalidatePath(`/invoices/${invoiceId}`)
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not cancel the invoice' }
  }
}
