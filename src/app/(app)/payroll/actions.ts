'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { approvePayroll, paySalaries } from '@/server/services/payroll/run'
import { setAnnualTaxEstimate } from '@/server/services/payroll/tds-192'
import { setAllocation } from '@/server/services/payroll/allocation'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { currentFinancialYear } from '@/server/services/accounting/period'

export async function approvePayrollAction(month: number, year: number) {
  const ctx = await requireContext()
  try {
    await approvePayroll(ctx, month, year)
    revalidatePath('/payroll/runs'); revalidatePath('/reports/project-pnl'); revalidatePath('/dashboard')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not approve the run' }
  }
}

export async function paySalariesAction(runId: string, date: string) {
  const ctx = await requireContext()
  try {
    await paySalaries(ctx, runId, date)
    revalidatePath('/payroll/runs')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not record the payment' }
  }
}

const EstimateSchema = z.object({
  employeeId: z.string().min(1),
  estimatedAnnualTax: z.string().min(1),
  source: z.string().optional(),
})

export async function setEstimateAction(_prev: { error?: string; ok?: boolean } | null, formData: FormData) {
  const ctx = await requireContext()
  assertCan(ctx.role, 'payroll', 'write')
  const parsed = EstimateSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return { error: 'No open financial year' }
  try {
    await setAnnualTaxEstimate({ companyId: ctx.companyId, financialYearId: fy.id, ...parsed.data })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not save the estimate' }
  }
  revalidatePath('/payroll/employees'); revalidatePath('/payroll/runs')
  return { ok: true }
}

export async function setAllocationAction(employeeId: string, periodFrom: string, periodTo: string, splits: { projectId: string | null; percent: string }[]) {
  const ctx = await requireContext()
  try {
    await setAllocation(ctx, { employeeId, periodFrom, periodTo, splits })
    revalidatePath('/payroll/employees'); revalidatePath('/reports/project-pnl')
    return { ok: true as const }
  } catch (e) {
    return { ok: false as const, error: e instanceof AppError ? e.message : 'Could not save the allocation' }
  }
}
