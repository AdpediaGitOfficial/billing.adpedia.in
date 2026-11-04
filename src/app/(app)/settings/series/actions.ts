'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { setSeriesPattern } from '@/server/services/invoicing/series-register'
import { AppError } from '@/server/errors'
import { DocType } from '@prisma/client'

const Schema = z.object({
  docType: z.nativeEnum(DocType),
  pattern: z.string().min(1, 'A pattern is required'),
})

export async function setSeriesPatternAction(
  _prev: { error?: string; ok?: string } | null, form: FormData,
) {
  const ctx = await requireContext()
  const parsed = Schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const r = await setSeriesPattern(ctx, parsed.data)
    revalidatePath('/settings/series')
    return {
      ok: `Saved. The next document takes ${r.nextNumber}. Everything already issued keeps the `
        + 'number it went out with — the sequence has not moved.',
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not change that pattern' }
  }
}
