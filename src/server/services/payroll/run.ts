import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import { fyQuarter } from '@/lib/fy'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { postPayrollRun, postSalaryPayment, PAYROLL_ACCOUNTS, type PayslipLine } from '@/server/services/accounting/rules/payroll'
import { computeMonthlyTds192 } from './tds-192'
import { professionTaxFor, isDeductionMonth, halfYearOf } from './profession-tax'
import { allocationFor, splitByAllocation } from './allocation'

export interface SalaryComponent { code: string; name: string; type: 'EARNING' | 'DEDUCTION'; amount: string }

export interface PayslipDraft {
  employeeId: string
  employeeName: string
  employeeCode: string
  isDirector: boolean
  components: SalaryComponent[]
  gross: Decimal
  deductions: Decimal
  professionTax: Decimal
  professionTaxNote: string | null
  tds: Decimal
  tdsNote: string
  tdsWarning?: string
  net: Decimal
  allocation: { projectId: string | null; projectName: string; percent: Decimal; amount: Decimal }[]
}

export interface PayrollPreview {
  month: number
  year: number
  label: string
  payslips: PayslipDraft[]
  grossTotal: Decimal
  tdsTotal: Decimal
  ptTotal: Decimal
  netTotal: Decimal
  warnings: string[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The structure in force for an employee in a given month. */
async function structureFor(employeeId: string, onDate: Date) {
  return prisma.salaryStructure.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })
}

export async function previewPayroll(ctx: RequestContext, month: number, year: number): Promise<PayrollPreview> {
  assertCan(ctx.role, 'payroll', 'read')

  const runDate = new Date(Date.UTC(year, month - 1, 28))
  const fy = await assertPostable(ctx.companyId, runDate)
  const company = await prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } })

  const employees = await prisma.employee.findMany({
    where: {
      companyId: ctx.companyId,
      joinedOn: { lte: runDate },
      OR: [{ leftOn: null }, { leftOn: { gte: runDate } }],
    },
    orderBy: [{ isDirector: 'desc' }, { name: 'asc' }],
  })

  const warnings: string[] = []
  const payslips: PayslipDraft[] = []

  for (const e of employees) {
    const structure = await structureFor(e.id, runDate)
    if (!structure) {
      warnings.push(`${e.name} has no salary structure in force for ${MONTHS[month - 1]} ${year} — they are excluded from this run.`)
      continue
    }

    const components = (structure.components as unknown as SalaryComponent[]) ?? []
    const earnings = components.filter((c) => c.type === 'EARNING').reduce((a, c) => a.plus(c.amount), ZERO)
    const otherDeductions = components.filter((c) => c.type === 'DEDUCTION').reduce((a, c) => a.plus(c.amount), ZERO)
    const gross = earnings.gt(0) ? earnings : new Decimal(structure.grossMonthly.toString())

    // ── profession tax: half-yearly, deducted in the month it falls due ──
    let professionTax = ZERO
    let professionTaxNote: string | null = null
    if (isDeductionMonth(month)) {
      const halfYearEarnings = round2(gross.mul(6))
      const pt = await professionTaxFor(company.stateCode, halfYearEarnings, runDate)
      professionTax = pt.amount
      professionTaxNote = pt.slabLabel
        ? `${halfYearOf(runDate)} half-year, slab ${pt.slabLabel} on ₹${halfYearEarnings.toFixed(0)}`
        : null
      if (pt.amount.isZero() && pt.slabLabel === null) {
        warnings.push(`No profession tax slab is on file for state ${company.stateCode}. Nothing will be deducted — confirm the slabs with your CA.`)
      }
    }

    // ── s.192 ──
    const tds = await computeMonthlyTds192({ companyId: ctx.companyId, employeeId: e.id, financialYearId: fy.id, month, year })
    if (tds.warning) warnings.push(`${e.name}: ${tds.warning}`)

    const net = gross.minus(otherDeductions).minus(professionTax).minus(tds.monthlyTds)

    const allocations = await allocationFor(e.id, runDate)
    const splits = allocations.map((a) => ({ projectId: a.projectId, percent: new Decimal(a.percent.toString()) }))
    const allocated = splitByAllocation(gross, splits)
    if (allocations.length === 0) {
      warnings.push(`${e.name} has no project allocation for this period — their cost lands as overhead, so project margins will understate it.`)
    }

    payslips.push({
      employeeId: e.id, employeeName: e.name, employeeCode: e.employeeCode, isDirector: e.isDirector,
      components, gross, deductions: otherDeductions,
      professionTax, professionTaxNote,
      tds: tds.monthlyTds, tdsNote: tds.reason, tdsWarning: tds.warning,
      net,
      allocation: allocated.map((a, i) => ({
        projectId: a.projectId,
        projectName: allocations[i]?.project?.name ?? 'Internal / overhead',
        percent: splits[i]?.percent ?? new Decimal(100),
        amount: a.amount,
      })),
    })
  }

  return {
    month, year, label: `${MONTHS[month - 1]} ${year}`,
    payslips,
    grossTotal: payslips.reduce((a, p) => a.plus(p.gross), ZERO),
    tdsTotal: payslips.reduce((a, p) => a.plus(p.tds), ZERO),
    ptTotal: payslips.reduce((a, p) => a.plus(p.professionTax), ZERO),
    netTotal: payslips.reduce((a, p) => a.plus(p.net), ZERO),
    warnings,
  }
}

/** Approve: create the payslips, post the ledger entry and record the s.192 deductions. */
export async function approvePayroll(ctx: RequestContext, month: number, year: number) {
  assertCan(ctx.role, 'payroll', 'approve')

  const preview = await previewPayroll(ctx, month, year)
  if (preview.payslips.length === 0) throw new AppError('Nothing to run — no employee has a salary structure in force')

  const runDate = new Date(Date.UTC(year, month - 1, 28))
  const fy = await assertPostable(ctx.companyId, runDate)

  return prisma.$transaction(async (tx) => {
    const existing = await tx.payrollRun.findFirst({ where: { companyId: ctx.companyId, year, month } })
    if (existing && existing.status !== 'DRAFT') throw new AppError(`${preview.label} payroll has already been approved`)

    const run = existing
      ? await tx.payrollRun.update({ where: { id: existing.id }, data: { status: 'APPROVED', grossTotal: preview.grossTotal.toFixed(2), tdsTotal: preview.tdsTotal.toFixed(2), netTotal: preview.netTotal.toFixed(2) } })
      : await tx.payrollRun.create({
          data: {
            companyId: ctx.companyId, financialYearId: fy.id, month, year, status: 'APPROVED',
            grossTotal: preview.grossTotal.toFixed(2), tdsTotal: preview.tdsTotal.toFixed(2), netTotal: preview.netTotal.toFixed(2),
          },
        })

    for (const p of preview.payslips) {
      await tx.payslip.upsert({
        where: { payrollRunId_employeeId: { payrollRunId: run.id, employeeId: p.employeeId } },
        update: {},
        create: {
          payrollRunId: run.id, employeeId: p.employeeId,
          gross: p.gross.toFixed(2), deductions: p.deductions.toFixed(2),
          professionTax: p.professionTax.toFixed(2), tds: p.tds.toFixed(2), net: p.net.toFixed(2),
          components: { components: p.components, allocation: p.allocation.map((a) => ({ projectName: a.projectName, percent: a.percent.toFixed(2), amount: a.amount.toFixed(2) })) } as never,
        },
      })

      if (p.tds.gt(0)) {
        await tx.tdsDeduction.create({
          data: {
            companyId: ctx.companyId, financialYearId: fy.id, quarter: fyQuarter(runDate),
            sectionCode: '192', deducteeType: 'EMPLOYEE',
            employeeId: p.employeeId, deducteePan: null,
            documentType: 'PAYROLL', documentId: run.id,
            deductedOn: runDate,
            baseAmount: p.gross.toFixed(2), ratePct: '0', tdsAmount: p.tds.toFixed(2),
          },
        })
      }
    }

    // ── the salary cost entry, with project dimensions from the allocation ──
    const lines: PayslipLine[] = preview.payslips.map((p) => ({
      employeeId: p.employeeId, isDirector: p.isDirector,
      gross: p.gross, deductions: p.deductions, professionTax: p.professionTax, tds: p.tds, net: p.net,
    }))

    const base = postPayrollRun({ label: preview.label, payslips: lines })

    // replace each aggregate salary debit with one line per employee per project, so
    // project cost is a dimension on the journal rather than a separate account
    const postings = base.flatMap((posting) => {
      if (posting.accountCode !== PAYROLL_ACCOUNTS.directorRemuneration && posting.accountCode !== PAYROLL_ACCOUNTS.staffSalaries) return [posting]
      const isDirectorLine = posting.accountCode === PAYROLL_ACCOUNTS.directorRemuneration
      return preview.payslips
        .filter((p) => p.isDirector === isDirectorLine)
        .flatMap((p) => p.allocation.filter((a) => a.amount.gt(0)).map((a) => ({
          accountCode: posting.accountCode,
          debit: a.amount,
          narration: `${p.employeeName} — ${a.projectName}`,
          employeeId: p.employeeId,
          projectId: a.projectId ?? undefined,
        })))
    })

    await postJournal(ctx, {
      date: runDate, narration: `Payroll ${preview.label}`,
      sourceType: 'PAYROLL', sourceId: run.id, postings,
    }, tx)

    await audit(ctx, { entity: 'PayrollRun', entityId: run.id, action: 'APPROVE', after: { label: preview.label, gross: preview.grossTotal.toFixed(2) } }, tx)
    return run
  })
}

export async function paySalaries(ctx: RequestContext, runId: string, date: string, bankAccountId?: string) {
  assertCan(ctx.role, 'payroll', 'approve')
  const on = new Date(date)
  await assertPostable(ctx.companyId, on)

  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, companyId: ctx.companyId } })
    if (!run) throw new NotFound('Payroll run not found')
    if (run.status !== 'APPROVED') throw new AppError('Only an approved run can be paid')

    const bank = bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({ where: { id: bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true } })
      : await tx.companyBankAccount.findFirstOrThrow({ where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true } })
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    await postJournal(ctx, {
      date: on, narration: `Salary paid — ${MONTHS[run.month - 1]} ${run.year}`,
      sourceType: 'PAYROLL', sourceId: run.id,
      postings: postSalaryPayment({
        label: `${MONTHS[run.month - 1]} ${run.year}`,
        amount: new Decimal(run.netTotal.toString()),
        bankAccountCode: bank.ledgerAccount.code,
      }),
    }, tx)

    const paid = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'PAID' } })
    await audit(ctx, { entity: 'PayrollRun', entityId: run.id, action: 'UPDATE', after: { status: 'PAID' } }, tx)
    return paid
  })
}
