'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { importStatement } from '@/server/services/banking/import'
import { applyMatch, reconciliationQueue } from '@/server/services/banking/reconcile'
import { unmatchBankTransaction } from '@/server/services/accounting/corrections'
import { prisma } from '@/server/db'
import { assertCan } from '@/server/auth/permissions'
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

/**
 * 🔴 docs/86 — `shownReason` is what makes the index safe.
 *
 * The suggestion is deliberately re-derived on the server rather than accepted from the
 * client, which is right: nothing the browser sends can invent an allocation. But it was
 * identified by its POSITION in a list rebuilt at the moment of the click, and that list
 * depends on which invoices are still open. Match one line in a statement and the next line's
 * suggestions can reorder underneath it — so "accept the second one" posted a receipt against
 * a different invoice from the one the person had just read, silently and with no way to tell
 * afterwards which it had been.
 *
 * The reason string is the suggestion in words — the amounts, the invoice numbers, the party
 * — and it is exactly what was on screen. If it no longer matches, the queue moved and the
 * person is asked to look again rather than having their click applied to something else.
 */
export async function applyMatchAction(
  txnId: string, suggestionIndex: number, learn: boolean, shownReason: string,
) {
  const ctx = await requireContext()
  try {
    const queue = await reconciliationQueue(ctx)
    const row = queue.find((q) => q.txn.id === txnId)
    if (!row) return { ok: false as const, error: 'That line is no longer in the queue' }
    const suggestion = row.suggestions[suggestionIndex]
    if (!suggestion) return { ok: false as const, error: 'That suggestion is no longer available' }
    if (suggestion.reason !== shownReason) {
      return {
        ok: false as const,
        error: 'The suggestions for this line have changed since the screen was drawn — '
          + 'it now reads "' + suggestion.reason + '". Nothing has been posted; look again.',
      }
    }
    await applyMatch(ctx, txnId, suggestion, { learn })
    revalidatePath('/banking/reconcile'); revalidatePath('/dashboard'); revalidatePath('/invoices')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not apply that match' }
  }
}

/**
 * 🔴 docs/86 — the one server action in the system that wrote without asking who was asking.
 *
 * Every other action either calls a service that begins with `assertCan` or asserts itself.
 * This one reached `prisma` directly, so a signed-in session was the whole of the check: an
 * AUDITOR, who holds `banking` at `read` precisely so the books cannot be touched, could mark
 * a bank line IGNORED — and so could an EMPLOYEE, who has no banking capability at all. An
 * ignored line leaves the reconciliation queue and does not come back, so money that arrived
 * is never matched to an invoice and the client is chased for it.
 *
 * `banking.post` at `approve`, the same capability `applyMatch` requires: deciding a line is
 * not worth posting is the same decision as deciding what to post it as.
 */
export async function skipTxnAction(txnId: string) {
  const ctx = await requireContext()
  assertCan(ctx.role, 'banking.post', 'approve')
  await prisma.bankTransaction.updateMany({
    where: { id: txnId, companyId: ctx.companyId },
    data: { status: 'IGNORED', matchReason: 'Skipped during reconciliation' },
  })
  revalidatePath('/banking/reconcile')
  return { ok: true as const }
}

/**
 * Put a matched bank line back in the queue — docs/49.
 *
 * 🔴 Not a flag change. The line was matched by POSTING something — a receipt, a bill
 * payment, a journal — so unmatching reverses that posting and then frees the line. The
 * service has done this since docs/40; there was simply no way to ask for it, which made a
 * wrong match permanent in the one screen whose whole job is deciding what a line is.
 */
export async function unmatchBankAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const id = String(form.get('txnId') ?? '')
  const reason = String(form.get('reason') ?? '')
  try {
    await unmatchBankTransaction(ctx, id, reason)
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not unmatch that line' }
  }
  revalidatePath('/banking/reconcile')
  revalidatePath('/receipts')
  revalidatePath('/bills')
  return { ok: 'Unmatched and reversed' }
}
