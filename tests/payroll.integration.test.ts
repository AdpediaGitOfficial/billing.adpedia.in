import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { previewPayroll, approvePayroll, paySalaries } from '@/server/services/payroll/run'
import { setAnnualTaxEstimate } from '@/server/services/payroll/tds-192'
import { setAllocation } from '@/server/services/payroll/allocation'
import { professionTaxFor, isDeductionMonth, halfYearOf } from '@/server/services/payroll/profession-tax'
import { projectPnl } from '@/server/services/reports/project-pnl'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let fyId = '', shinelal = '', akash = '', prime = '', nuve = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })).id

  shinelal = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'ADP-001' } })).id
  akash = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'ADP-002' } })).id

  const customer = await prisma.customer.create({
    data: { companyId: company.id, name: 'Click AR Business Pvt Ltd', country: 'IN', stateCode: '32', customerType: 'B2B', billingAddress: {}, paymentTermDays: 15 },
  })
  prime = (await prisma.project.create({ data: { companyId: company.id, customerId: customer.id, code: 'PRIME-WEB', name: 'Prime — Website', contractValue: '800000', status: 'ACTIVE' } })).id
  nuve  = (await prisma.project.create({ data: { companyId: company.id, customerId: customer.id, code: 'NUVE', name: 'Nuvé — Brand Film', contractValue: '400000', status: 'ACTIVE' } })).id

  const inv = await createInvoice(ctx, {
    customerId: customer.id, projectId: prime, date: '2026-06-30',
    lines: [{ description: 'Milestone 1', sacCode: '998314', quantity: '1', rate: '400000', gstRatePct: '18' }],
  })
  await sendInvoice(ctx, inv.id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('Kerala profession tax', () => {
  it('falls due in September and March only', () => {
    expect(isDeductionMonth(9)).toBe(true)
    expect(isDeductionMonth(3)).toBe(true)
    expect(isDeductionMonth(6)).toBe(false)
    expect(halfYearOf(new Date('2026-06-15'))).toBe('H1')
    expect(halfYearOf(new Date('2026-11-15'))).toBe('H2')
  })

  it('picks the slab from half-yearly earnings', async () => {
    const d = new Date('2026-09-28')
    expect((await professionTaxFor('32', new Decimal('10000'), d)).amount.toFixed(2)).toBe('0.00')
    expect((await professionTaxFor('32', new Decimal('50000'), d)).amount.toFixed(2)).toBe('450.00')
    expect((await professionTaxFor('32', new Decimal('480000'), d)).amount.toFixed(2)).toBe('1250.00')
  })

  it('🔴 taxes an amount that falls BETWEEN two published bands', async () => {
    // The Kerala table is written in whole rupees: …11999, then 12000. Matching on both
    // bounds leaves ₹11,999.50 in no band at all, and it silently returns zero — which
    // looks identical to an employee genuinely below the first slab. A mid-month joiner
    // produces exactly this. Matching on the lower bound only removes the gap.
    const d = new Date('2026-09-28')
    expect((await professionTaxFor('32', new Decimal('11999.50'), d)).amount.toFixed(2)).toBe('0.00')
    expect((await professionTaxFor('32', new Decimal('17999.99'), d)).amount.toFixed(2)).toBe('120.00')
    expect((await professionTaxFor('32', new Decimal('29999.50'), d)).amount.toFixed(2)).toBe('180.00')
    expect((await professionTaxFor('32', new Decimal('124999.99'), d)).amount.toFixed(2)).toBe('1000.00')
  })

  it('names the band it applied, so a payslip can be explained', async () => {
    const d = new Date('2026-09-28')
    expect((await professionTaxFor('32', new Decimal('50000'), d)).slabLabel).toBe('₹45000–₹59999')
    expect((await professionTaxFor('32', new Decimal('480000'), d)).slabLabel).toBe('above ₹125000')
  })

  it('🔴 never exceeds ₹2,500 across both halves of a year', async () => {
    // Article 276(2) is a constitutional ceiling, not a guideline
    const h1 = await professionTaxFor('32', new Decimal('5000000'), new Date('2026-09-28'))
    const h2 = await professionTaxFor('32', new Decimal('5000000'), new Date('2027-03-28'))
    expect(h1.amount.plus(h2.amount).toFixed(2)).toBe('2500.00')
  })
})

describe('🔴 s.192 is prorated from the CA estimate, not a flat rate', () => {
  it('deducts nothing and warns while no estimate is on file', async () => {
    const p = await previewPayroll(ctx, 6, 2026)
    const s = p.payslips.find((x) => x.employeeId === shinelal)!
    expect(s.tds.toFixed(2)).toBe('0.00')
    expect(p.warnings.join(' ')).toMatch(/No annual tax estimate|cannot be computed without the CA/)
  })

  it('spreads the estimate over the months remaining', async () => {
    // June is month 3 of the financial year, so 10 months remain including it
    await setAnnualTaxEstimate({ companyId: ctx.companyId, employeeId: shinelal, financialYearId: fyId, estimatedAnnualTax: '600000', source: 'CA estimate, Jun 2026' })
    const p = await previewPayroll(ctx, 6, 2026)
    const s = p.payslips.find((x) => x.employeeId === shinelal)!
    expect(s.tds.toFixed(2)).toBe('60000.00')     // 600,000 / 10
    expect(s.tdsNote).toMatch(/10 months/)
  })

  it('recomputes as deductions accumulate', async () => {
    await approvePayroll(ctx, 6, 2026)
    const p = await previewPayroll(ctx, 7, 2026)
    const s = p.payslips.find((x) => x.employeeId === shinelal)!
    // 600,000 estimate less 60,000 already deducted, over the 9 months that remain
    expect(s.tds.toFixed(2)).toBe('60000.00')
    expect(s.tdsNote).toMatch(/9 months/)
  })

  it('a revised estimate supersedes rather than overwrites', async () => {
    await setAnnualTaxEstimate({ companyId: ctx.companyId, employeeId: shinelal, financialYearId: fyId, estimatedAnnualTax: '450000', source: 'Revised after declarations' })
    const rows = await prisma.salaryTaxEstimate.findMany({ where: { employeeId: shinelal }, orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0].supersededAt).not.toBeNull()
    expect(rows[1].supersededAt).toBeNull()

    const p = await previewPayroll(ctx, 7, 2026)
    const s = p.payslips.find((x) => x.employeeId === shinelal)!
    expect(s.tds.toFixed(2)).toBe('43333.33')     // (450,000 − 60,000) / 9
  })
})

describe('the monthly run', () => {
  it('covers everyone with a structure in force', async () => {
    const p = await previewPayroll(ctx, 8, 2026)
    expect(p.payslips).toHaveLength(4)
    expect(p.grossTotal.toFixed(2)).toBe('415000.00')   // 238,000 + 80,000 + 55,000 + 42,000
  })

  it('deducts profession tax in September and not in August', async () => {
    const aug = await previewPayroll(ctx, 8, 2026)
    expect(aug.ptTotal.toFixed(2)).toBe('0.00')
    const sep = await previewPayroll(ctx, 9, 2026)
    expect(sep.ptTotal.gt(new Decimal(0))).toBe(true)
    const s = sep.payslips.find((x) => x.employeeId === shinelal)!
    expect(s.professionTax.toFixed(2)).toBe('1250.00')  // top slab on 6 × 238,000
    expect(s.professionTaxNote).toMatch(/H1 half-year/)
  })

  it('posts a balanced entry splitting the director from staff', async () => {
    await approvePayroll(ctx, 8, 2026)
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId: ctx.companyId, month: 8, year: 2026 } })
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'PAYROLL', sourceId: run.id }, include: { lines: { include: { account: true } } },
    })
    const debit = entry.lines.reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0))
    const credit = entry.lines.reduce((a, l) => a.plus(l.credit.toString()), new Decimal(0))
    expect(debit.toFixed(2)).toBe(credit.toFixed(2))

    const director = entry.lines.filter((l) => l.account.code === '5110').reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0))
    const staff = entry.lines.filter((l) => l.account.code === '5120').reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0))
    expect(director.toFixed(2)).toBe('238000.00')
    expect(staff.toFixed(2)).toBe('177000.00')
    expect(entry.lines.find((l) => l.account.code === '2210')).toBeTruthy()   // TDS payable 192
  })

  it('records the s.192 deductions for the quarterly 24Q', async () => {
    const d = await prisma.tdsDeduction.findMany({ where: { companyId: ctx.companyId, sectionCode: '192' } })
    expect(d.length).toBeGreaterThan(0)
    expect(d.every((x) => x.deducteeType === 'EMPLOYEE')).toBe(true)
    expect(d.every((x) => x.quarter >= 1 && x.quarter <= 4)).toBe(true)
  })

  it('refuses to approve the same month twice', async () => {
    await expect(approvePayroll(ctx, 8, 2026)).rejects.toThrow(/already been approved/)
  })

  it('pays the net and clears salary payable', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId: ctx.companyId, month: 8, year: 2026 } })
    await paySalaries(ctx, run.id, '2026-09-01')
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('PAID')
  })
})

describe('🔴 staff allocation makes project margin real', () => {
  it('insists allocations total 100%', async () => {
    await expect(setAllocation(ctx, {
      employeeId: akash, periodFrom: '2026-04-01', periodTo: '2027-03-31',
      splits: [{ projectId: prime, percent: '60' }, { projectId: nuve, percent: '30' }],
    })).rejects.toThrow(/must total 100%.*comes to 90/)
  })

  it('splits one salary across projects as a journal dimension', async () => {
    await setAllocation(ctx, {
      employeeId: akash, periodFrom: '2026-04-01', periodTo: '2027-03-31',
      splits: [{ projectId: prime, percent: '60' }, { projectId: nuve, percent: '30' }, { projectId: null, percent: '10' }],
    })
    const p = await previewPayroll(ctx, 10, 2026)
    const a = p.payslips.find((x) => x.employeeId === akash)!
    expect(a.allocation.map((x) => x.amount.toFixed(2))).toEqual(['48000.00', '24000.00', '8000.00'])
    expect(a.allocation.reduce((s, x) => s.plus(x.amount), new Decimal(0)).toFixed(2)).toBe('80000.00')
  })

  it('project P&L now carries staff cost, not just revenue', async () => {
    await approvePayroll(ctx, 10, 2026)
    const rows = await projectPnl(ctx, fyId)
    const p = rows.find((r) => r.code === 'PRIME-WEB')!
    const n = rows.find((r) => r.code === 'NUVE')!

    expect(p.revenue.toFixed(2)).toBe('400000.00')
    expect(p.staffCost.toFixed(2)).toBe('48000.00')    // 60% of Akash
    expect(p.grossProfit.toFixed(2)).toBe('352000.00')
    expect(p.marginPct!.toFixed(1)).toBe('88.0')

    // a project with cost and no revenue shows a loss rather than nothing
    expect(n.revenue.toFixed(2)).toBe('0.00')
    expect(n.staffCost.toFixed(2)).toBe('24000.00')
    expect(n.grossProfit.toFixed(2)).toBe('-24000.00')
    expect(n.marginPct).toBeNull()
  })

  it('the unallocated tenth stays as overhead, outside any project', async () => {
    const rows = await projectPnl(ctx, fyId)
    const allocatedStaff = rows.reduce((a, r) => a.plus(r.staffCost), new Decimal(0))
    expect(allocatedStaff.toFixed(2)).toBe('72000.00')   // 48,000 + 24,000, not the full 80,000
  })
})
