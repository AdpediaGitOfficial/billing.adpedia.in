import type { PrismaClient } from '@prisma/client'
import { Decimal } from '../../src/lib/money'
import { assertWithinConstitutionalCap } from '../../src/server/services/payroll/profession-tax'

/**
 * Kerala profession tax — half-yearly slabs.
 *
 * ⚠️ PROVENANCE: this is the published Kerala half-yearly table, levied by the local body
 * under the Kerala Municipality Act 1994 (s.245) and the Panchayat Raj Act. It is stated to
 * the best of my knowledge and is NOT a CA's opinion. The slabs are set by the LOCAL BODY,
 * so Chalakudy's schedule is the one that governs Adpedia and should be confirmed against
 * the municipality's own notification before the first deduction.
 *
 * The totals check out against the one figure that cannot move: ₹1,250 × 2 half-years =
 * ₹2,500 a year, exactly the ceiling in Article 276(2) of the Constitution. A table that
 * exceeded that would be wrong regardless of what any circular said — `seedProfessionTax`
 * asserts it rather than trusting the numbers below.
 *
 * It applies regardless of headcount: EPF needs 20 employees and ESI needs 10, so
 * neither touches Adpedia — this one does.
 *
 * Due dates: H1 (Apr–Sep) by 31 August, H2 (Oct–Mar) by 28 February.
 */
const FROM = new Date(Date.UTC(2025, 3, 1))

export const KERALA_PT_SLABS = [
  { from: '0',      to: '11999',  amount: '0' },
  { from: '12000',  to: '17999',  amount: '120' },
  { from: '18000',  to: '29999',  amount: '180' },
  { from: '30000',  to: '44999',  amount: '300' },
  { from: '45000',  to: '59999',  amount: '450' },
  { from: '60000',  to: '74999',  amount: '600' },
  { from: '75000',  to: '99999',  amount: '750' },
  { from: '100000', to: '124999', amount: '1000' },
  { from: '125000', to: null,     amount: '1250' },
] as const

export async function seedProfessionTax(prisma: PrismaClient, stateCode = '32') {
  // refuse to seed a table that breaches the constitutional ceiling
  const top = KERALA_PT_SLABS.reduce((m, s) => Math.max(m, Number(s.amount)), 0)
  assertWithinConstitutionalCap(new Decimal(top))

  const existing = await prisma.professionTaxSlab.count({ where: { stateCode, effectiveFrom: FROM } })
  if (existing > 0) return existing
  for (const s of KERALA_PT_SLABS) {
    await prisma.professionTaxSlab.create({
      data: { stateCode, fromAmount: s.from, toAmount: s.to, amount: s.amount, effectiveFrom: FROM },
    })
  }
  return KERALA_PT_SLABS.length
}

/**
 * The four people on payroll, per docs/04 §6 — confirmed by the client.
 * Shinelal is the director; his remuneration is paid as salary under s.192, which is
 * why it carries no GST and no deemed-dividend exposure.
 */
export const PAYROLL_PEOPLE = [
  { code: 'ADP-001', name: 'Shinelal',          designation: 'Director',            isDirector: true,  gross: '238000' },
  { code: 'ADP-002', name: 'Akash Raveendran',  designation: 'Full-stack developer', isDirector: false, gross: '80000' },
  { code: 'ADP-003', name: 'Deepak Damodaran',  designation: 'Developer',            isDirector: false, gross: '55000' },
  { code: 'ADP-004', name: 'Kiran N S',         designation: 'Developer',            isDirector: false, gross: '42000' },
] as const

export async function seedEmployees(prisma: PrismaClient, companyId: string) {
  const effectiveFrom = new Date(Date.UTC(2026, 3, 1))   // start of FY 2026-27
  for (const p of PAYROLL_PEOPLE) {
    const employee = await prisma.employee.upsert({
      where: { companyId_employeeCode: { companyId, employeeCode: p.code } },
      update: {},
      create: {
        companyId, employeeCode: p.code, name: p.name, designation: p.designation,
        isDirector: p.isDirector, joinedOn: effectiveFrom, taxRegime: 'NEW',
      },
    })
    const hasStructure = await prisma.salaryStructure.findFirst({ where: { employeeId: employee.id } })
    if (!hasStructure) {
      await prisma.salaryStructure.create({
        data: {
          employeeId: employee.id,
          effectiveFrom,
          grossMonthly: p.gross,
          components: [
            { code: 'BASIC', name: 'Basic', type: 'EARNING', amount: (Number(p.gross) * 0.5).toFixed(2) },
            { code: 'HRA', name: 'House rent allowance', type: 'EARNING', amount: (Number(p.gross) * 0.2).toFixed(2) },
            { code: 'SPECIAL', name: 'Special allowance', type: 'EARNING', amount: (Number(p.gross) * 0.3).toFixed(2) },
          ],
        },
      })
    }
  }
  return PAYROLL_PEOPLE.length
}
