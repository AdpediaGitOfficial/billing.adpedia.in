import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { noteTotals } from '@/server/services/invoicing/notes'
import type { Period } from './ledger'

export interface ClientPnlRow {
  customerId: string
  name: string
  revenue: Decimal
  directCost: Decimal
  otherCost: Decimal
  totalCost: Decimal
  grossProfit: Decimal
  marginPct: Decimal | null
  projectCount: number
  /** still unsettled at the end of the period — profit is not cash */
  outstanding: Decimal
}

/**
 * Client P&L — the same journal lines as the project view, grouped by the customer
 * dimension instead of the project one.
 *
 * Costs reach a client two ways: tagged to the customer directly, or tagged to one of
 * their projects. Both are counted, which is why this is not simply `GROUP BY customerId`:
 * a payroll allocation lands on the project, never on the customer.
 */
export async function clientPnl(ctx: RequestContext, period: Period): Promise<ClientPnlRow[]> {
  assertCan(ctx.role, 'reports', 'read')

  const customers = await prisma.customer.findMany({
    where: { companyId: ctx.companyId },
    include: { projects: { select: { id: true } } },
    orderBy: { name: 'asc' },
  })
  if (customers.length === 0) return []

  const projectOwner = new Map<string, string>()
  for (const c of customers) for (const p of c.projects) projectOwner.set(p.id, c.id)

  const lines = await prisma.journalLine.findMany({
    where: {
      journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } },
      OR: [{ customerId: { not: null } }, { projectId: { in: [...projectOwner.keys()] } }],
    },
    include: { account: { select: { code: true, type: true } } },
  })

  const agg = new Map<string, { revenue: Decimal; direct: Decimal; other: Decimal }>()
  for (const l of lines) {
    const customerId = l.customerId ?? (l.projectId ? projectOwner.get(l.projectId) : undefined)
    if (!customerId) continue
    const a = agg.get(customerId) ?? { revenue: ZERO, direct: ZERO, other: ZERO }
    const debit = new Decimal(l.debit.toString())
    const credit = new Decimal(l.credit.toString())

    if (l.account.type === 'INCOME') {
      a.revenue = a.revenue.plus(credit).minus(debit)
    } else if (l.account.type === 'EXPENSE') {
      const net = debit.minus(credit)
      if (l.account.code.startsWith('51') || l.account.code.startsWith('52')) a.direct = a.direct.plus(net)
      else a.other = a.other.plus(net)
    }
    agg.set(customerId, a)
  }

  // outstanding is a position, not a movement — as at the end of the period
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] },
      date: { lte: period.to },
    },
    select: { id: true, customerId: true, grandTotal: true, amountReceived: true, tdsCredited: true, tdsAmount: true },
  })
  // 🔴 docs/86 — net of credit notes, so this agrees with the client's own running account
  const notes = await noteTotals(ctx.companyId, invoices.map((i) => i.id))
  const outstandingBy = new Map<string, Decimal>()
  for (const i of invoices) {
    const { outstanding } = invoiceOpen(i, notes.get(i.id) ?? NO_NOTES)
    outstandingBy.set(i.customerId, (outstandingBy.get(i.customerId) ?? ZERO).plus(outstanding))
  }

  return customers
    .map((c) => {
      const a = agg.get(c.id) ?? { revenue: ZERO, direct: ZERO, other: ZERO }
      const totalCost = a.direct.plus(a.other)
      const grossProfit = a.revenue.minus(totalCost)
      return {
        customerId: c.id, name: c.name,
        revenue: a.revenue, directCost: a.direct, otherCost: a.other, totalCost, grossProfit,
        marginPct: a.revenue.gt(0) ? grossProfit.div(a.revenue).mul(100) : null,
        projectCount: c.projects.length,
        outstanding: outstandingBy.get(c.id) ?? ZERO,
      }
    })
    .filter((r) => !r.revenue.isZero() || !r.totalCost.isZero() || !r.outstanding.isZero())
    .sort((a, b) => b.revenue.comparedTo(a.revenue))
}
