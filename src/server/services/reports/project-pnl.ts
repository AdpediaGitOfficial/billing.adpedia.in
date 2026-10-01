import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'

export interface ProjectPnlRow {
  projectId: string
  code: string
  name: string
  customerName: string
  revenue: Decimal
  staffCost: Decimal
  vendorCost: Decimal
  otherCost: Decimal
  totalCost: Decimal
  grossProfit: Decimal
  marginPct: Decimal | null
  contractValue: Decimal | null
}

/**
 * 🔴 This is the query the whole dimension design exists for.
 *
 * Revenue, staff cost and vendor cost are all GROUP BY projectId over journal lines —
 * no parallel chart of accounts, no reconciliation between two sets of numbers. Staff
 * cost only appears once payroll is allocated (docs/12 §2.7), which is why project
 * margin was notional before phase 4 and is real after it.
 */
export async function projectPnl(ctx: RequestContext, financialYearId?: string): Promise<ProjectPnlRow[]> {
  assertCan(ctx.role, 'reports', 'read')

  const fy = financialYearId
    ? await prisma.financialYear.findUniqueOrThrow({ where: { id: financialYearId } })
    : await prisma.financialYear.findFirstOrThrow({ where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' } })

  const projects = await prisma.project.findMany({
    where: { companyId: ctx.companyId },
    include: { customer: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  if (projects.length === 0) return []

  const lines = await prisma.journalLine.findMany({
    where: {
      projectId: { in: projects.map((p) => p.id) },
      journalEntry: { companyId: ctx.companyId, financialYearId: fy.id },
    },
    include: { account: { select: { code: true, type: true } } },
  })

  const byProject = new Map<string, { revenue: Decimal; staff: Decimal; vendor: Decimal; other: Decimal }>()
  for (const l of lines) {
    const acc = byProject.get(l.projectId!) ?? { revenue: ZERO, staff: ZERO, vendor: ZERO, other: ZERO }
    const debit = new Decimal(l.debit.toString())
    const credit = new Decimal(l.credit.toString())

    if (l.account.type === 'INCOME') {
      acc.revenue = acc.revenue.plus(credit).minus(debit)
    } else if (l.account.type === 'EXPENSE') {
      const net = debit.minus(credit)
      if (l.account.code.startsWith('51')) acc.staff = acc.staff.plus(net)
      else if (l.account.code.startsWith('52')) acc.vendor = acc.vendor.plus(net)
      else acc.other = acc.other.plus(net)
    }
    byProject.set(l.projectId!, acc)
  }

  return projects.map((p) => {
    const a = byProject.get(p.id) ?? { revenue: ZERO, staff: ZERO, vendor: ZERO, other: ZERO }
    const totalCost = a.staff.plus(a.vendor).plus(a.other)
    const grossProfit = a.revenue.minus(totalCost)
    return {
      projectId: p.id, code: p.code, name: p.name, customerName: p.customer.name,
      revenue: a.revenue, staffCost: a.staff, vendorCost: a.vendor, otherCost: a.other,
      totalCost, grossProfit,
      marginPct: a.revenue.gt(0) ? grossProfit.div(a.revenue).mul(100) : null,
      contractValue: p.contractValue ? new Decimal(p.contractValue.toString()) : null,
    }
  })
}
