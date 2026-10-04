'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { lockPeriod, unlockPeriod, closeYear, reopenYear, createNextFinancialYear } from '@/server/services/accounting/close'
import { AppError } from '@/server/errors'
import { setOpeningBalances } from '@/server/services/accounting/opening'

type Result = { error?: string; ok?: string } | null

function fail(e: unknown): Result {
  return { error: e instanceof AppError ? e.message : 'Something went wrong' }
}

export async function lockAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  const fyId = String(form.get('fyId') ?? '')
  const upTo = String(form.get('upTo') ?? '')
  if (!upTo) return { error: 'Pick a date to lock up to' }
  try {
    await lockPeriod(ctx, fyId, new Date(`${upTo}T23:59:59Z`))
  } catch (e) { return fail(e) }
  revalidatePath('/accounting/close')
  return { ok: `Locked to ${upTo}` }
}

export async function unlockAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    await unlockPeriod(ctx, String(form.get('fyId') ?? ''), null, String(form.get('reason') ?? ''))
  } catch (e) { return fail(e) }
  revalidatePath('/accounting/close')
  return { ok: 'Period unlocked' }
}

export async function closeAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    const r = await closeYear(ctx, String(form.get('fyId') ?? ''))
    revalidatePath('/accounting/close')
    return { ok: `Closed. ${r.accountsSwept} accounts swept, ${r.netProfit.toFixed(2)} to retained earnings.` }
  } catch (e) { return fail(e) }
}

export async function reopenAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  try {
    await reopenYear(ctx, String(form.get('fyId') ?? ''), String(form.get('reason') ?? ''))
  } catch (e) { return fail(e) }
  revalidatePath('/accounting/close')
  return { ok: 'Year reopened — the closing entry has been reversed, not removed' }
}

// takes the useActionState signature even though it reads neither argument — the year it
// creates follows from the latest one on file, not from anything the form says
export async function createNextFyAction(): Promise<Result> {
  const ctx = await requireContext()
  try {
    const r = await createNextFinancialYear(ctx)
    revalidatePath('/accounting/close')
    return { ok: `FY ${r.label} opened, with ${r.seriesCopied} numbering series carried over` }
  } catch (e) { return fail(e) }
}

/**
 * Opening balances — docs/74. Replaces whatever stands by reversing it, so this is both the
 * "set" and the "restate" path.
 */
export async function setOpeningBalancesAction(_prev: Result, form: FormData): Promise<Result> {
  const ctx = await requireContext()
  let lines: { accountCode: string; debit?: string; credit?: string }[]
  try {
    lines = JSON.parse(String(form.get('lines') ?? '[]'))
  } catch {
    return { error: 'Could not read those lines' }
  }
  try {
    await setOpeningBalances(ctx, {
      financialYearId: String(form.get('financialYearId') ?? ''),
      lines,
      note: String(form.get('note') ?? ''),
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not post the opening entry' }
  }
  revalidatePath('/accounting/close')
  revalidatePath('/reports/balance-sheet')
  revalidatePath('/accounting/trial-balance')
  return { ok: 'Posted' }
}
