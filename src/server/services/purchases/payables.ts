import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'

export interface PayableRow {
  billId: string
  billNumber: string
  vendorName: string
  vendorId: string
  billDate: Date
  dueDate: Date
  grandTotal: Decimal
  tdsWithheld: Decimal
  paid: Decimal
  /** what the vendor is actually owed — gross less TDS less what has been paid */
  outstanding: Decimal
  daysOverdue: number
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+'
  isRcm: boolean
}

const DAY = 86_400_000

/**
 * The mirror of AR ageing: TDS is withheld, not owed. A ₹2,36,000 bill with ₹20,000 of
 * TDS is settled by paying the vendor ₹2,16,000 — the rest goes to the government.
 */
export async function apAgeing(ctx: RequestContext, asOf = new Date()): Promise<PayableRow[]> {
  assertCan(ctx.role, 'bills', 'read')

  const bills = await prisma.vendorBill.findMany({
    where: { companyId: ctx.companyId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  return bills.map((b) => {
    const grandTotal = new Decimal(b.grandTotal.toString())
    const tdsWithheld = new Decimal(b.tdsAmount.toString())
    const paid = new Decimal(b.amountPaid.toString())
    const outstanding = Decimal.max(grandTotal.minus(tdsWithheld).minus(paid), ZERO)
    const daysOverdue = outstanding.gt(0) ? Math.max(0, Math.floor((asOf.getTime() - b.dueDate.getTime()) / DAY)) : 0

    return {
      billId: b.id, billNumber: b.billNumber,
      vendorName: b.vendor.name, vendorId: b.vendor.id,
      billDate: b.billDate, dueDate: b.dueDate,
      grandTotal, tdsWithheld, paid, outstanding, daysOverdue,
      bucket: daysOverdue === 0 ? 'current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+',
      isRcm: b.isRcm,
    }
  })
}

export async function apSummary(ctx: RequestContext, asOf = new Date()) {
  const rows = await apAgeing(ctx, asOf)
  const buckets: Record<PayableRow['bucket'], Decimal> = { current: ZERO, '1-30': ZERO, '31-60': ZERO, '61-90': ZERO, '90+': ZERO }
  let total = ZERO, tdsWithheld = ZERO, overdueCount = 0, dueThisWeek = ZERO

  const weekOut = new Date(asOf.getTime() + 7 * DAY)
  for (const r of rows) {
    buckets[r.bucket] = buckets[r.bucket].plus(r.outstanding)
    total = total.plus(r.outstanding)
    tdsWithheld = tdsWithheld.plus(r.tdsWithheld)
    if (r.daysOverdue > 0) overdueCount++
    if (r.dueDate <= weekOut) dueThisWeek = dueThisWeek.plus(r.outstanding)
  }
  return { rows, buckets, total, tdsWithheld, overdueCount, dueThisWeek, billCount: rows.length }
}

/** TDS deducted but not yet linked to a challan — the amount due to the government. */
export async function tdsPayableSummary(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  const rows = await prisma.tdsDeduction.groupBy({
    by: ['sectionCode'],
    where: { companyId: ctx.companyId, challanId: null, reversedAt: null },
    _sum: { tdsAmount: true },
    _count: true,
  })
  const total = rows.reduce((a, r) => a.plus(r._sum.tdsAmount?.toString() ?? 0), ZERO)
  return { bySection: rows.map((r) => ({ section: r.sectionCode, amount: new Decimal(r._sum.tdsAmount?.toString() ?? 0), count: r._count })), total }
}
