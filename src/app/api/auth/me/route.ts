import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { currentFinancialYear } from '@/server/services/accounting/period'

export async function GET() {
  return handler(async () => {
    const ctx = await requireContext()
    const [user, company, fy] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { id: true, name: true, email: true } }),
      prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { id: true, legalName: true, tradeName: true, gstin: true, stateCode: true } }),
      currentFinancialYear(ctx.companyId),
    ])
    return { user, company, role: ctx.role, financialYear: fy && { id: fy.id, label: fy.label } }
  })
}
