import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { approvePayroll } from '@/server/services/payroll/run'
import { setAnnualTaxEstimate } from '@/server/services/payroll/tds-192'
import { renderPayslipHtml } from '@/server/services/payroll/render-payslip'
import { assertMayReadPayslip, employeeForUser } from '@/server/services/payroll/access'
import { cancelPayrollRun } from '@/server/services/accounting/corrections'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', fyId = ''
let shinelal = '', akash = '', slipId = '', othersSlipId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id

  shinelal = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'ADP-001' } })).id
  akash = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'ADP-002' } })).id

  for (const id of [shinelal, akash]) {
    await setAnnualTaxEstimate({ companyId, employeeId: id, financialYearId: fyId, estimatedAnnualTax: '120000', note: 'CA estimate' })
  }
  // September — the month profession tax falls due, so one slip carries both deductions
  const run = await approvePayroll(ctx, 9, 2026)
  const slips = await prisma.payslip.findMany({ where: { payrollRunId: run.id } })
  slipId = slips.find((s) => s.employeeId === shinelal)!.id
  othersSlipId = slips.find((s) => s.employeeId === akash)!.id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 who may read a payslip', () => {
  it('lets anyone with the payroll capability read any of them', async () => {
    await expect(assertMayReadPayslip({ ...ctx, role: 'ACCOUNTANT' }, slipId)).resolves.toBeTruthy()
    await expect(assertMayReadPayslip({ ...ctx, role: 'AUDITOR' }, slipId)).resolves.toBeTruthy()
  })

  it('refuses a role with no payroll capability at all', async () => {
    await expect(assertMayReadPayslip({ ...ctx, role: 'PROJECT_MANAGER' }, slipId))
      .rejects.toThrow(/cannot read payroll/)
  })

  it('🔴 refuses an EMPLOYEE another employee’s payslip', async () => {
    // payroll.own means their OWN slip. Scoping by company alone — which is all every other
    // document route does — would hand any employee the directors' salaries by changing an id.
    const user = await prisma.user.findFirstOrThrow()
    await prisma.employee.update({ where: { id: akash }, data: { email: user.email } })

    await expect(assertMayReadPayslip({ ...ctx, role: 'EMPLOYEE' }, othersSlipId)).resolves.toBeTruthy()
    await expect(assertMayReadPayslip({ ...ctx, role: 'EMPLOYEE' }, slipId))
      .rejects.toThrow(/belongs to somebody else/)
  })

  it('🔴 refuses an EMPLOYEE with no employee record rather than letting them through', async () => {
    await prisma.employee.update({ where: { id: akash }, data: { email: 'someone.else@example.com' } })
    expect(await employeeForUser({ ...ctx, role: 'EMPLOYEE' })).toBeNull()
    await expect(assertMayReadPayslip({ ...ctx, role: 'EMPLOYEE' }, othersSlipId))
      .rejects.toThrow(/belongs to somebody else/)
  })

  it('refuses a payslip belonging to another company', async () => {
    await expect(assertMayReadPayslip({ ...ctx, companyId: 'not-this-company' }, slipId))
      .rejects.toThrow(/not found/i)
  })
})

describe('the payslip document', () => {
  it('names every deduction with what it is made under', async () => {
    const html = await renderPayslipHtml(companyId, slipId)
    expect(html).toContain('Income tax deducted at source')
    expect(html).toContain('Profession tax')
    expect(html).toMatch(/Section 192|s\.192|estimate/)
    expect(html).toContain('September 2026')
  })

  it('🔴 explains the two deductions people assume are errors', async () => {
    const html = await renderPayslipHtml(companyId, slipId)
    // s.192 is the year's estimate spread over the months left, not a tax on this month
    expect(html).toMatch(/spreads it over the months that remain|spread/i)
    // and profession tax is deducted in two months out of twelve
    expect(html).toMatch(/twice a year/)
    expect(html).toMatch(/2,500/)
  })

  it('🔴 shows the earnings even when the structure carried no itemised components', async () => {
    const html = await renderPayslipHtml(companyId, slipId)
    const earnings = html.slice(html.indexOf('id="earnings"'), html.indexOf('Gross earnings'))
    expect(earnings).toMatch(/<tr>/)
  })

  it('carries the year so far, which is what Form 16 will be built from', async () => {
    const html = await renderPayslipHtml(companyId, slipId)
    const ytd = html.slice(html.indexOf('id="ytd"'), html.indexOf('</tbody>', html.indexOf('id="ytd"')))
    expect(ytd).toContain('Gross')
    expect(ytd).toContain('Tax deducted')
  })

  it('🔴 shows only the last four digits of the bank account', async () => {
    await prisma.employee.update({
      where: { id: shinelal },
      data: { bankDetails: { bankName: 'Federal Bank', accountNo: '10340100123456', ifsc: 'FDRL0001034' } },
    })
    const html = await renderPayslipHtml(companyId, slipId)
    expect(html).toContain('3456')
    expect(html).not.toContain('10340100123456')
  })

  it('says so plainly when there is no PAN, because the TDS cannot then be reported', async () => {
    await prisma.employee.update({ where: { id: shinelal }, data: { pan: null } })
    const html = await renderPayslipHtml(companyId, slipId)
    expect(html).toContain('Not on record')
  })

  it('renders to a real PDF', async () => {
    const pdf = await htmlToPdf(await renderPayslipHtml(companyId, slipId))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(5000)
  })
})

describe('🔴 a payslip that must not go out', () => {
  it('refuses to issue one from a draft run', async () => {
    const draft = await prisma.payrollRun.create({
      data: { companyId, financialYearId: fyId, month: 11, year: 2026, status: 'DRAFT' },
    })
    const slip = await prisma.payslip.create({
      data: {
        payrollRunId: draft.id, employeeId: shinelal,
        gross: '50000', deductions: '0', professionTax: '0', tds: '0', net: '50000', components: {},
      },
    })
    await expect(renderPayslipHtml(companyId, slip.id))
      .rejects.toThrow(/still a draft/)
  })

  it('marks a cancelled run’s payslip void rather than hiding it', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId, month: 9, year: 2026, cancelledAt: null } })
    await cancelPayrollRun(ctx, run.id, 'Run approved against the wrong month', new Date('2026-10-02'))

    const html = await renderPayslipHtml(companyId, slipId)
    expect(html).toContain('st-cancelled')
    expect(html).toMatch(/not evidence of any payment/)
    expect(html).toMatch(/Run approved against the wrong month/)
    expect(html).toContain('Net pay (void)')
  })

  it('🔴 drops a cancelled run out of the year-to-date totals', async () => {
    const html = await renderPayslipHtml(companyId, slipId)
    const ytd = html.slice(html.indexOf('id="ytd"'), html.indexOf('</tbody>', html.indexOf('id="ytd"')))
    // the only run of the year has been cancelled, so nothing counts towards Form 16
    expect(ytd).toMatch(/0\.00/)
  })
})
