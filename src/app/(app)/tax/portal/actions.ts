'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { importPortalStatement, reconcileChallans } from '@/server/services/tax/portal-reconciliation'
import { AppError } from '@/server/errors'

const Schema = z.object({
  kind: z.enum(['GST_CASH_LEDGER', 'GST_CREDIT_LEDGER', 'GST_CHALLANS', 'TDS_CHALLANS']),
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
