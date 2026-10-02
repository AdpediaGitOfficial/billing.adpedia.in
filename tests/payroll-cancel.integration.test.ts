import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { approvePayroll, paySalaries } from '@/server/services/payroll/run'
import { setAnnualTaxEstimate } from '@/server/services/payroll/tds-192'
import { cancelPayrollRun, cancelTdsChallan } from '@/server/services/accounting/corrections'
import { createChallan, outstandingDeductions } from '@/server/services/tax/tds-challan'
import { recordTdsFiling, isQuarterFiled, recordTdsCorrection, listTdsCorrections } from '@/server/services/tax/tds-filing'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', fyId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const balance = async (code: string) =>
  (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id

  // s.192 deducts nothing until the CA's annual estimate is on file
  for (const e of await prisma.employee.findMany({ where: { companyId } })) {
    await setAnnualTaxEstimate({
      companyId, financialYearId: fyId, employeeId: e.id,
      estimatedAnnualTax: '120000', source: 'CA estimate for the test',
    })
  }
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 cancelling a payroll run', () => {
  it('reverses the cost and the payment, and frees the deductions', async () => {
    const run = await approvePayroll(ctx, 7, 2026)
    await paySalaries(ctx, run.id, '2026-07-31')

    const salaryBefore = await balance('5120')
    expect(Number(salaryBefore)).toBeGreaterThan(0)
    const deductions = await prisma.tdsDeduction.count({ where: { documentId: run.id, reversedAt: null } })
    expect(deductions).toBeGreaterThan(0)

    await cancelPayrollRun(ctx, run.id, 'Approved against the wrong salary structure', new Date('2026-08-02'))

    // both journals reversed — the cost and the payment
    expect(await balance('5120')).toBe('0.00')
    expect(await balance('2300')).toBe('0.00')
    expect(await balance('2210')).toBe('0.00')
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)

    // the s.192 deductions leave the challan queue
    expect(await prisma.tdsDeduction.count({ where: { documentId: run.id, reversedAt: null } })).toBe(0)
    const owed = await outstandingDeductions(ctx)
    expect(owed.filter((d) => d.sectionCode === '192')).toHaveLength(0)
  })

  it('keeps the run and its payslips on file', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId, month: 7, year: 2026 } })
    expect(run.status).toBe('CANCELLED')
    expect(run.cancelReason).toMatch(/wrong salary structure/)
    expect(await prisma.payslip.count({ where: { payrollRunId: run.id } })).toBeGreaterThan(0)
  })

  it('🔴 lets the month be run again', async () => {
    // the cancelled run keeps its row, so a unique index on the month would have made July
    // permanently unrunnable
    const again = await approvePayroll(ctx, 7, 2026)
    expect(again.status).toBe('APPROVED')
    expect(Number(await balance('5120'))).toBeGreaterThan(0)
  })

  it('refuses a second cancellation and demands a reason', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId, month: 7, year: 2026, cancelledAt: null } })
    await expect(cancelPayrollRun(ctx, run.id, 'no')).rejects.toThrow(/needs a reason/)
    await cancelPayrollRun(ctx, run.id, 'Reversed again for the test', new Date('2026-08-03'))
    await expect(cancelPayrollRun(ctx, run.id, 'Reversed again for the test', new Date('2026-08-03')))
      .rejects.toThrow(/already cancelled/)
  })
})

describe('🔴 what a payroll run cannot be cancelled against', () => {
  let runId = ''

  it('refuses once the TDS has been deposited', async () => {
    const run = await approvePayroll(ctx, 8, 2026)
    runId = run.id
    const deductions = await prisma.tdsDeduction.findMany({
      where: { documentId: run.id, reversedAt: null, challanId: null },
    })
    await createChallan(ctx, {
      sectionCode: '192', quarter: 2, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '00234', depositedOn: '2026-09-07',
    })

    // the government has the money and the employees are credited with it
    await expect(cancelPayrollRun(ctx, run.id, 'Changed our mind about the run'))
      .rejects.toThrow(/already been deposited/)
  })

  it('refuses once the quarter’s 24Q reports it', async () => {
    // the August run is deposited and the quarter is filed, so its TDS is in the return and
    // in every employee's 26AS
    await recordTdsFiling(ctx, { formType: '24Q', quarter: 2, filedOn: '2026-10-31', token: '030610300081234' })
    expect((await isQuarterFiled(companyId, 2, '24Q')).filed).toBe(true)

    await expect(cancelPayrollRun(ctx, runId, 'Changed our mind about the run'))
      .rejects.toThrow(/already been deposited/)

    // and still refused once the deposit is out of the way, because the return reported it
    const challan = await prisma.tdsChallan.findFirstOrThrow({ where: { companyId, challanSerial: '00234' } })
    await expect(cancelTdsChallan(ctx, challan.id, 'Recorded with the wrong BSR code'))
      .rejects.toThrow(/backed by this CIN/)
  })

  it('🔴 does NOT block a run that the filed return never saw', async () => {
    // a September run approved after the Q2 return went in is in none of its figures, so
    // cancelling it contradicts nothing — "the quarter is filed, so nothing may be touched"
    // would have trapped a genuine mistake behind a return it was never part of
    const late = await approvePayroll(ctx, 9, 2026)
    const filed = await isQuarterFiled(companyId, 2, '24Q')
    expect(filed.filed).toBe(true)

    await cancelPayrollRun(ctx, late.id, 'Approved by mistake after the return went in', new Date('2026-11-02'))
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: late.id } })).status).toBe('CANCELLED')
  })

  it('🔴 is not blocked by a different form’s filing', async () => {
    // a 192 deduction is reported on 24Q; a filed 26Q says nothing about it
    expect((await isQuarterFiled(companyId, 2, '26Q')).filed).toBe(false)
  })
})

describe('🔴 cancelling a TDS challan', () => {
  let challanId = ''

  it('puts the deductions back in the queue with their interest still running', async () => {
    const run = await approvePayroll(ctx, 10, 2026)   // Q3, which nothing has filed
    const deductions = await prisma.tdsDeduction.findMany({
      where: { documentId: run.id, reversedAt: null, challanId: null },
    })
    const challan = await createChallan(ctx, {
      sectionCode: '192', quarter: 3, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '00555', depositedOn: '2026-11-07',
    })
    challanId = challan.id
    expect((await outstandingDeductions(ctx)).filter((d) => d.sectionCode === '192')).toHaveLength(0)

    await cancelTdsChallan(ctx, challan.id, 'Duplicate of the challan already recorded', new Date('2026-11-20'))

    // 🔴 outstanding again, not reversed — the deductions were real, the deposit record was not
    const owed = (await outstandingDeductions(ctx)).filter((d) => d.sectionCode === '192')
    expect(owed.length).toBe(deductions.length)
    expect(owed[0].interestIfPaidToday.gte(0)).toBe(true)

    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('keeps the challan on file, cancelled', async () => {
    const c = await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challanId } })
    expect(c.cancelledAt).not.toBeNull()
    expect(c.cancelReason).toMatch(/Duplicate/)
  })

  it('refuses once the quarter’s return reports the deposit', async () => {
    const deductions = await prisma.tdsDeduction.findMany({
      where: { companyId, sectionCode: '192', quarter: 3, reversedAt: null, challanId: null },
    })
    const challan = await createChallan(ctx, {
      sectionCode: '192', quarter: 3, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '00777', depositedOn: '2026-11-07',
    })
    await recordTdsFiling(ctx, { formType: '24Q', quarter: 3, filedOn: '2027-01-31' })

    await expect(cancelTdsChallan(ctx, challan.id, 'Wrong serial on the counterfoil'))
      .rejects.toThrow(/backed by this CIN/)
  })
})

describe('the filing record', () => {
  it('refuses a malformed receipt number', async () => {
    await expect(recordTdsFiling(ctx, { formType: '26Q', quarter: 3, filedOn: '2027-01-31', token: '123' }))
      .rejects.toThrow(/15 digits/)
  })

  it('refuses a second record of the same return', async () => {
    await expect(recordTdsFiling(ctx, { formType: '24Q', quarter: 2, filedOn: '2026-10-31' }))
      .rejects.toThrow(/already recorded as filed/)
  })

  it('🔴 refuses when the deductions and the challans disagree', async () => {
    // a return cannot have been accepted with those apart, so recording it as filed would be
    // recording something that did not happen
    const run = await approvePayroll(ctx, 1, 2027)   // Q4, nothing deposited
    expect(run.status).toBe('APPROVED')
    await expect(recordTdsFiling(ctx, { formType: '24Q', quarter: 4, filedOn: '2027-05-31' }))
      .rejects.toThrow(/cannot have been accepted with those apart/)
  })

  it('snapshots what was reported', async () => {
    const row = await prisma.tdsReturnFiling.findFirstOrThrow({ where: { companyId, formType: '24Q', quarter: 2 } })
    expect(row.deducteeCount).toBeGreaterThan(0)
    expect(new Decimal(row.tdsDeducted.toString()).gt(0)).toBe(true)
    expect(row.tdsDeducted.toString()).toBe(row.tdsDeposited.toString())
  })

  it('tells the compliance calendar the quarter is done', async () => {
    const cal = await complianceCalendar(ctx)
    const item = cal.find((i) => i.id === 'tds-return-q2')!
    expect(item.state).toBe('DONE')
    expect(item.detail).toMatch(/Filed — 24Q/)

    const q4 = cal.find((i) => i.id === 'tds-return-q4')!
    expect(q4.state).not.toBe('DONE')
    expect(q4.detail).toMatch(/24Q still to file/)
  })
})

describe('🔴 a correction statement re-opens exactly what it corrects — docs/52', () => {
  let filingId = '', runId = ''

  it('sets up a run the filed 24Q reports', async () => {
    const run = await approvePayroll(ctx, 2, 2027)      // Q4
    runId = run.id
    // every Q4 deduction, not just this run's — an earlier test left January's undeposited,
    // and a return cannot be filed with the two sides apart
    const deductions = await prisma.tdsDeduction.findMany({
      where: { companyId, quarter: 4, sectionCode: '192', reversedAt: null, challanId: null },
    })
    await createChallan(ctx, {
      sectionCode: '192', quarter: 4, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '01010', depositedOn: '2027-03-07',
    })
    const filing = await recordTdsFiling(ctx, { formType: '24Q', quarter: 4, filedOn: '2027-05-31' })
    filingId = filing.id
    expect(Number(filing.tdsDeducted)).toBeGreaterThan(0)
  })

  it('is refused before the correction, on both counts', async () => {
    await expect(cancelPayrollRun(ctx, runId, 'The whole run was wrong'))
      .rejects.toThrow(/already been deposited/)

    const challan = await prisma.tdsChallan.findFirstOrThrow({ where: { companyId, challanSerial: '01010' } })
    await expect(cancelTdsChallan(ctx, challan.id, 'The challan was wrong too'))
      .rejects.toThrow(/backed by this CIN/)
  })

  it('refuses a correction dated before the return it corrects', async () => {
    await expect(recordTdsCorrection(ctx, {
      filingId, category: 'C3', filedOn: '2027-04-01', reason: 'Dated before the original',
      tdsDeducted: '0', tdsDeposited: '0',
    })).rejects.toThrow(/cannot be filed before the return/)
  })

  it('refuses a category that is not one of NSDL’s', async () => {
    await expect(recordTdsCorrection(ctx, {
      filingId, category: 'C7' as never, filedOn: '2027-06-15', reason: 'Made-up category',
      tdsDeducted: '0', tdsDeposited: '0',
    })).rejects.toThrow(/not a correction category/)
  })

  it('🔴 lets the challan go once a C2 says the deposit is no longer reported', async () => {
    const challan = await prisma.tdsChallan.findFirstOrThrow({ where: { companyId, challanSerial: '01010' } })
    const filing = await prisma.tdsReturnFiling.findUniqueOrThrow({ where: { id: filingId } })

    await recordTdsCorrection(ctx, {
      filingId, category: 'C2', filedOn: '2027-06-15', token: '030610300099999',
      reason: 'Challan quoted with the wrong BSR code; removed from the return',
      tdsDeducted: filing.tdsDeducted.toString(), tdsDeposited: '0',
    })

    await cancelTdsChallan(ctx, challan.id, 'Recorded with the wrong BSR code', new Date('2027-03-20'))
    expect((await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } })).cancelledAt).not.toBeNull()
  })

  it('🔴 and the run once a C3 says the deductees are no longer reported', async () => {
    // the deposit guard is already satisfied — the challan is gone — so this proves the
    // filing guard is what was left, and that the correction is what cleared it
    await expect(cancelPayrollRun(ctx, runId, 'The whole run was wrong', new Date('2027-03-21')))
      .rejects.toThrow(/reporting/)

    await recordTdsCorrection(ctx, {
      filingId, category: 'C3', filedOn: '2027-06-20',
      reason: 'Deductees removed — the run was never payable',
      tdsDeducted: '0', tdsDeposited: '0',
    })

    await cancelPayrollRun(ctx, runId, 'The whole run was wrong', new Date('2027-03-21'))
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('CANCELLED')
  })

  it('🔴 does not re-open anything the correction did not touch', async () => {
    // Q2's 24Q still reports its own deductions, and no correction has been filed against it
    const q2 = await prisma.tdsReturnFiling.findFirstOrThrow({ where: { companyId, formType: '24Q', quarter: 2 } })
    expect(Number(q2.tdsDeducted)).toBeGreaterThan(0)
    expect((await isQuarterFiled(companyId, 2, '24Q')).filed).toBe(true)
  })

  it('keeps every correction on file against its return', async () => {
    const rows = await listTdsCorrections(ctx, filingId)
    expect(rows.map((r) => r.category).sort()).toEqual(['C2', 'C3'])
    expect(rows[0].filing.formType).toBe('24Q')
  })
})
