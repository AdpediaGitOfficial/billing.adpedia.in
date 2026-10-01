'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { recordGstFiling, unrecordGstFiling } from '@/server/services/tax/gst-filing'
import { recordGstPayment } from '@/server/services/tax/gst-payment'
import { AppError } from '@/server/errors'
import type { GstReturnType } from '@prisma/client'

type Result = { error?: string; ok?: string } | null

export async function recordFilingAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    const row = await recordGstFiling(ctx, {
      returnType: String(form.get('returnType') ?? 'GSTR1') as GstReturnType,
      periodLabel: String(form.get('periodLabel') ?? ''),
      filedOn: String(form.get('filedOn') ?? ''),
      arn: String(form.get('arn') ?? '') || undefined,
    })
    revalidatePath('/tax/gst')
    revalidatePath('/tax/calendar')
    return { ok: `${row.returnType} for ${row.periodLabel} recorded. The period is now locked.` }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that filing' }
  }
}

export async function unrecordFilingAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    const r = await unrecordGstFiling(ctx, String(form.get('id') ?? ''), String(form.get('reason') ?? ''))
    revalidatePath('/tax/gst')
    revalidatePath('/tax/calendar')
    return { ok: r.note }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not remove that record' }
  }
}

export async function recordPaymentAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    const c = await recordGstPayment(ctx, {
      periodLabel: String(form.get('periodLabel') ?? ''),
      paidOn: String(form.get('paidOn') ?? ''),
      cpin: String(form.get('cpin') ?? '') || undefined,
      cin: String(form.get('cin') ?? '') || undefined,
      cgst: String(form.get('cgst') ?? '0'),
      sgst: String(form.get('sgst') ?? '0'),
      igst: String(form.get('igst') ?? '0'),
      rcm: String(form.get('rcm') ?? '0'),
      interest: String(form.get('interest') ?? '0'),
      lateFee: String(form.get('lateFee') ?? '0'),
    })
    revalidatePath('/tax/gst')
    revalidatePath('/tax/calendar')
    return { ok: `Challan ${c.cin} recorded — ${c.amount.toString()} posted against ${c.periodLabel}.` }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that payment' }
  }
}
