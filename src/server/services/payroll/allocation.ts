import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'

export interface AllocationInput {
  employeeId: string
  periodFrom: string
  periodTo: string
  splits: { projectId: string | null; percent: string }[]
}

/**
 * Staff allocation turns salary into project cost — the thing that makes project margin
 * real rather than notional (docs/04 §6, docs/12 §2.7).
 *
 * 🔴 Allocation does NOT move money between accounts. Salary stays in 5110/5120 for the
 * P&L and the journal lines carry projectId as a DIMENSION. Project cost is then a
 * GROUP BY, not a parallel chart of accounts — see docs/11 §2.1.
 */
export async function setAllocation(ctx: RequestContext, input: AllocationInput) {
  assertCan(ctx.role, 'payroll', 'write')

  const total = input.splits.reduce((a, s) => a.plus(new Decimal(s.percent)), ZERO)
  if (!total.equals(100)) {
    throw new AppError(`Allocations must total 100% — this one comes to ${total.toFixed(2)}%. Put the remainder against Internal if the time is not billable.`)
  }

  const employee = await prisma.employee.findFirst({ where: { id: input.employeeId, companyId: ctx.companyId } })
  if (!employee) throw new AppError('Employee not found')

  const periodFrom = new Date(input.periodFrom)
  const periodTo = new Date(input.periodTo)

  return prisma.$transaction(async (tx) => {
    await tx.staffAllocation.deleteMany({ where: { employeeId: input.employeeId, periodFrom, periodTo } })
    for (const s of input.splits) {
      if (new Decimal(s.percent).isZero()) continue
      await tx.staffAllocation.create({
        data: { employeeId: input.employeeId, projectId: s.projectId, periodFrom, periodTo, percent: new Decimal(s.percent).toFixed(2) },
      })
    }
    return tx.staffAllocation.findMany({ where: { employeeId: input.employeeId, periodFrom } })
  })
}

/** The allocation in force for an employee on a given date. */
export async function allocationFor(employeeId: string, onDate: Date) {
  return prisma.staffAllocation.findMany({
    where: { employeeId, periodFrom: { lte: onDate }, periodTo: { gte: onDate } },
    include: { project: { select: { id: true, name: true } } },
  })
}

/** Split one employee's gross across their projects, with the remainder on the last split. */
export function splitByAllocation(
  gross: Decimal, splits: { projectId: string | null; percent: Decimal }[],
): { projectId: string | null; amount: Decimal }[] {
  if (splits.length === 0) return [{ projectId: null, amount: gross }]
  const out: { projectId: string | null; amount: Decimal }[] = []
  let allocated = ZERO
  splits.forEach((s, i) => {
    const amount = i === splits.length - 1 ? gross.minus(allocated) : round2(gross.mul(s.percent).div(100))
    allocated = allocated.plus(amount)
    out.push({ projectId: s.projectId, amount })
  })
  return out
}
