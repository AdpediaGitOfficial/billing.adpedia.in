'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { importPortalStatement, reconcileChallans } from '@/server/services/tax/portal-reconciliation'
import { import2b, reconcile2b } from '@/server/services/tax/gstr2b'
import { AppError } from '@/server/errors'

const Schema = z.object({
  kind: z.enum(['GST_CASH_LEDGER', 'GST_CREDIT_LEDGER', 'GST_CHALLANS', 'TDS_CHALLANS', 'GST_2B']),
  asOn: z.string().min(8, 'Say what date the portal figures are as at'),
  text: z.string().min(5, 'Paste the statement first'),
  filename: z.string().optional(),
})

export async function importStatementAction(
  _prev: { error?: string; ok?: string } | null, formData: FormData,
) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    // 🔴 docs/62 — a 2B is invoice-level and has its own importer; the ledger and challan
    // parser would read a JSON document as nothing at all and report it unreadable.
    if (parsed.data.kind === 'GST_2B') {
      const r = await import2b(ctx, parsed.data)
      const recon = await reconcile2b(ctx)
      revalidatePath('/tax/portal')
      return {
        ok: `Read ${r.rows} invoice${r.rows === 1 ? '' : 's'}` +
          (r.skipped.length ? `, could not read ${r.skipped.length} (${r.skipped[0].reason})` : '') +
          `. ${recon.verdict}.`,
      }
    }

    const result = await importPortalStatement(ctx, parsed.data)
    let tail = ''
    if (parsed.data.kind === 'TDS_CHALLANS' || parsed.data.kind === 'GST_CHALLANS') {
      const r = await reconcileChallans(ctx, parsed.data.kind)
      tail = ` ${r.verdict}.`
    }
    revalidatePath('/tax/portal'); revalidatePath('/tax/gst'); revalidatePath('/tax/tds')
    return {
      ok: `Read ${result.rows} row${result.rows === 1 ? '' : 's'}` +
        (result.skipped.length ? `, could not read ${result.skipped.length} (${result.skipped[0].reason})` : '') +
        `.${tail}`,
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not read that statement' }
  }
}
