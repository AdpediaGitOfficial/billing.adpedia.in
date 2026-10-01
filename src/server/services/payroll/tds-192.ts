import { prisma } from '@/server/db'
import type { Tx } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'

export interface Tds192Result {
  monthlyTds: Decimal
  estimatedAnnualTax: Decimal
  deductedSoFar: Decimal
  monthsRemaining: number
  reason: string
  warning?: string
}

/**
 * 🔴 s.192 is NOT a flat rate on each payment.
 *
 * It is 1/12 of the employee's estimated ANNUAL tax liability, recomputed each month as
 * the picture changes:
 *
 *     monthly = (estimated annual tax − already deducted this FY) / months remaining
 *
 * The estimated annual tax comes from the CA. Regime election, investment declarations,
 * house-property loss and other income all feed it, and none of that belongs in an
 * accounting system guessing at the Income Tax Act. This records their number, prorates
 * it, and shows its working.
 */
export async function computeMonthlyTds192(args: {
  companyId: string
  employeeId: string
  financialYearId: string
  /** 1-12 calendar month of the payroll run */
  month: number
  year: number
  tx?: Tx
}): Promise<Tds192Result> {
  const { companyId, employeeId, financialYearId, month, tx = prisma } = args

  const estimate = await tx.salaryTaxEstimate.findFirst({
    where: { companyId, employeeId, financialYearId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
  })

  // months remaining in the financial year, inclusive of this one (Apr = 12 … Mar = 1)
  const monthsRemaining = month >= 4 ? 12 - month + 4 : 4 - month

  if (!estimate) {
    return {
      monthlyTds: ZERO, estimatedAnnualTax: ZERO, deductedSoFar: ZERO, monthsRemaining,
      reason: 'No annual tax estimate on file',
      warning: 'TDS cannot be computed without the CA’s estimated annual tax for this employee. Nothing will be deducted until it is entered — and under-deduction carries interest at 1% a month.',
    }
  }

  const prior = await tx.payslip.aggregate({
    where: { employeeId, payrollRun: { companyId, financialYearId, status: { not: 'DRAFT' } } },
    _sum: { tds: true },
  })
  const deductedSoFar = new Decimal(prior._sum.tds?.toString() ?? 0)
  const annual = new Decimal(estimate.estimatedAnnualTax.toString())
  const outstanding = Decimal.max(annual.minus(deductedSoFar), ZERO)

  if (monthsRemaining <= 0) {
    return { monthlyTds: outstanding, estimatedAnnualTax: annual, deductedSoFar, monthsRemaining: 0,
      reason: 'Final month — the whole remaining liability falls due' }
  }

  const monthlyTds = round2(outstanding.div(monthsRemaining))
  return {
    monthlyTds,
    estimatedAnnualTax: annual,
    deductedSoFar,
    monthsRemaining,
    reason: `${formatINR(outstanding)} outstanding over ${monthsRemaining} month${monthsRemaining === 1 ? '' : 's'}`,
    warning: deductedSoFar.isZero() && monthsRemaining < 9
      ? `Nothing has been deducted yet this year and only ${monthsRemaining} months remain. The catch-up is steep, and short deduction earlier in the year carries interest at 1% a month.`
      : undefined,
  }
}

/** Record or revise the CA's estimate. A revision supersedes rather than overwrites. */
export async function setAnnualTaxEstimate(args: {
  companyId: string; employeeId: string; financialYearId: string
  estimatedAnnualTax: string; source?: string; note?: string
}) {
  await prisma.salaryTaxEstimate.updateMany({
    where: { companyId: args.companyId, employeeId: args.employeeId, financialYearId: args.financialYearId, supersededAt: null },
    data: { supersededAt: new Date() },
  })
  return prisma.salaryTaxEstimate.create({
    data: {
      companyId: args.companyId, employeeId: args.employeeId, financialYearId: args.financialYearId,
      estimatedAnnualTax: new Decimal(args.estimatedAnnualTax).toFixed(2),
      source: args.source, note: args.note,
    },
  })
}
