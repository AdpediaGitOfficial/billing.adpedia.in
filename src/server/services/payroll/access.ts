import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { can } from '@/server/auth/permissions'
import { Forbidden, NotFound } from '@/server/errors'

/**
 * Who may read a payslip — docs/57.
 *
 * 🔴 Every document before this one answered "is the reader in this company?" and stopped.
 * That is the right question for an invoice, which the whole finance team works on. It is the
 * wrong question for a payslip: an EMPLOYEE holds `payroll.own`, and the only honest reading
 * of "own" is *their own slip*, not everybody's. Scoping by company alone would have let any
 * employee read the directors' salaries by changing an id in a URL.
 */

/**
 * The employee record behind a signed-in user.
 *
 * 🔴 Matched by email, within this company. There is no `userId` on Employee — the one
 * screen that needed this (`/payroll/me`) grew its own copy of the rule, and a second copy
 * in the document route is exactly how the two drift until one of them is wrong. One
 * function, used by both.
 *
 * The company filter is load-bearing: without it a shared address would surface another
 * entity's payslips.
 */
export async function employeeForUser(ctx: RequestContext) {
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } })
  if (!user?.email) return null
  return prisma.employee.findFirst({
    where: { companyId: ctx.companyId, email: user.email },
    select: {
      id: true, name: true, employeeCode: true, designation: true, pan: true, email: true,
    },
  })
}

/** Throws unless this reader may see this payslip. Returns the payslip's run status. */
export async function assertMayReadPayslip(ctx: RequestContext, payslipId: string) {
  const slip = await prisma.payslip.findFirst({
    where: { id: payslipId, payrollRun: { companyId: ctx.companyId } },
    select: { id: true, employeeId: true, payrollRun: { select: { status: true } } },
  })
  if (!slip) throw new NotFound('Payslip not found')

  if (can(ctx.role, 'payroll', 'read')) return slip

  if (can(ctx.role, 'payroll.own', 'read')) {
    const mine = await employeeForUser(ctx)
    // 🔴 No employee record means no payslip is theirs — never "therefore allow". The
    // permissive reading of an unmatched email is the one that leaks the payroll.
    if (mine && mine.id === slip.employeeId) return slip
    throw new Forbidden('That payslip belongs to somebody else')
  }

  throw new Forbidden(`${ctx.role} cannot read payroll`)
}
