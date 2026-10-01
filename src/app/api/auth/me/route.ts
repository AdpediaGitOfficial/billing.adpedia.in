import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'

export async function GET() {
  return handler(async () => {
    const ctx = await requireContext()
    const [user, company, fy] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { id: true, name: true, email: true } }),
      prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { id: true, legalName: true, tradeName: true, gstin: true, stateCode: true } }),
      prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' } }),
    ])
    return { user, company, role: ctx.role, financialYear: fy && { id: fy.id, label: fy.label } }
  })
}
