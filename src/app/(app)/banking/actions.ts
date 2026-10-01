'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { importStatement } from '@/server/services/banking/import'
import { applyMatch, reconciliationQueue } from '@/server/services/banking/reconcile'
import { prisma } from '@/server/db'
import { AppError } from '@/server/errors'

const ImportSchema = z.object({
  bankAccountId: z.string().min(1),
  profileKey: z.enum(['AXIS', 'HDFC']),
  text: z.string().min(20, 'Paste the statement rows first'),
  openingBalance: z.string().optional(),
  closingBalance: z.string().optional(),
  force: z.string().optional(),
})

export async function importStatementAction(_prev: { error?: string; ok?: string } | null, formData: FormData) {
  const ctx = await requireContext()
  const parsed = ImportSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  try {
    const r = await importStatement(ctx, { ...parsed.data, force: parsed.data.force === 'on' })
    revalidatePath('/banking/reconcile'); revalidatePath('/banking/import')
    return {
      ok: `Imported ${r.imported} line${r.imported === 1 ? '' : 's'}` +
        (r.duplicates ? `, ignored ${r.duplicates} already on file` : '') +
        (r.skipped.length ? `, skipped ${r.skipped.length} unreadable` : '') +
        `. Balance check ${r.balanceCheck.ok ? 'passed' : 'FAILED'}.`,
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not import that statement' }
  }
}

export async function applyMatchAction(txnId: string, suggestionIndex: number, learn: boolean) {
  const ctx = await requireContext()
  try {
    const queue = await reconciliationQueue(ctx)
    const row = queue.find((q) => q.txn.id === txnId)
    if (!row) return { ok: false as const, error: 'That line is no longer in the queue' }
    const suggestion = row.suggestions[suggestionIndex]
    if (!suggestion) return { ok: false as const, error: 'That suggestion is no longer available' }
    await applyMatch(ctx, txnId, suggestion, { learn })
    revalidatePath('/banking/reconcile'); revalidatePath('/dashboard'); revalidatePath('/invoices')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not apply that match' }
  }
}

export async function skipTxnAction(txnId: string) {
  const ctx = await requireContext()
  await prisma.bankTransaction.updateMany({
    where: { id: txnId, companyId: ctx.companyId },
    data: { status: 'IGNORED', matchReason: 'Skipped during reconciliation' },
  })
  revalidatePath('/banking/reconcile')
  return { ok: true as const }
}
