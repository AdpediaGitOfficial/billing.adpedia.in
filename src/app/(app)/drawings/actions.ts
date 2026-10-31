'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { recordOwnerMovement } from '@/server/services/equity/drawings'
import { AppError } from '@/server/errors'
import { formatINR } from '@/lib/money'
import type { DrawingPurpose, MoneySource, OwnerMovementKind } from '@prisma/client'

type Result = { error?: string; ok?: string } | null

export async function recordMovementAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  const str = (k: string) => String(form.get(k) ?? '').trim()
  const kind = (str('kind') || 'DRAWING') as OwnerMovementKind

  try {
    const m = await recordOwnerMovement(ctx, {
      kind,
      date: str('date'),
      amount: str('amount'),
      // 🔴 the service refuses a purpose on CAPITAL, so it is not sent on one — a hidden field
      // left in the form would otherwise arrive from whichever state the radio was last in
      purpose: kind === 'DRAWING' ? (str('purpose') as DrawingPurpose) || null : null,
      source: (str('source') || 'BANK') as MoneySource,
      narration: str('narration'),
    })
    revalidatePath('/drawings')
    revalidatePath('/reports/balance-sheet')
    return {
      ok: kind === 'DRAWING'
        ? `${formatINR(m.amount.toString())} recorded as drawings. It reduces the capital account and not the profit — nothing on the P&L moved.`
        : `${formatINR(m.amount.toString())} recorded as capital introduced.`,
    }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not record that' }
  }
}
