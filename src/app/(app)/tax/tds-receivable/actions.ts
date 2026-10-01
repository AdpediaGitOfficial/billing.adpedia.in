'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { import26as, reconcile26as } from '@/server/services/tax/form26as'
import { markForm16aReceived } from '@/server/services/tax/tds-receivable'
import { AppError } from '@/server/errors'

const Schema = z.object({ text: z.string().min(10, 'Paste the 26AS rows first') })

export async function import26asAction(_prev: { error?: string; ok?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const fy = await prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' } })
  if (!fy) return { error: 'No open financial year' }

  try {
    const result = await import26as(ctx, parsed.data.text, fy.id)
    const recon = await reconcile26as(ctx, fy.id)
    revalidatePath('/tax/tds-receivable'); revalidatePath('/dashboard')
    return {
      ok: `Imported ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}. ` +
        `Matched ${recon.matched.length}, ${recon.missingIn26as.length} missing from 26AS, ${recon.notInBooks.length} not in the books.`,
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not import that file' }
  }
}

export async function markReceivedAction(ids: string[]) {
  const ctx = await requireContext()
  try {
    await markForm16aReceived(ctx, ids)
    revalidatePath('/tax/tds-receivable')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not update' }
  }
}
