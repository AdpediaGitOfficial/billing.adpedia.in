import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'

export interface AgeingRow {
  invoiceId: string
  number: string
  customerId: string
  customerName: string
  projectName: string | null
  date: Date
  dueDate: Date
  currency: string
  grandTotal: Decimal
  received: Decimal
  tdsCredited: Decimal
  /** TDS the customer is expected to deduct but has not yet paid over */
  tdsExpected: Decimal
  /** cash we can still actually collect */
  collectible: Decimal
  daysOverdue: number
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+'
}

const DAY = 86_400_000

/**
 * 🔴 The TDS nuance (docs/02 §B1).
 *
 * A ₹1,00,300 invoice where the customer deducts ₹8,500 of TDS is fully settled by a
 * payment of ₹91,800. If ageing treats the ₹8,500 as collectible, every paid invoice
 * looks permanently overdue and the follow-up list cries wolf until nobody reads it.
 *
 * So: collectible = grandTotal − received − tdsCredited − tdsStillExpected.
 */
export async function arAgeing(ctx: RequestContext, asOf = new Date()): Promise<AgeingRow[]> {
  assertCan(ctx.role, 'invoices', 'read')

  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] },
    },
    include: { customer: { select: { id: true, name: true } }, project: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  return invoices.map((inv) => {
    const grandTotal = new Decimal(inv.grandTotal.toString())
    const received = new Decimal(inv.amountReceived.toString())
    const tdsCredited = new Decimal(inv.tdsCredited.toString())
    const tdsOnInvoice = new Decimal(inv.tdsAmount.toString())

    // whatever portion of the expected TDS has not yet been credited
    const tdsExpected = Decimal.max(tdsOnInvoice.minus(tdsCredited), ZERO)
    const collectible = Decimal.max(grandTotal.minus(received).minus(tdsCredited).minus(tdsExpected), ZERO)

    const daysOverdue = collectible.gt(0) ? Math.max(0, Math.floor((asOf.getTime() - inv.dueDate.getTime()) / DAY)) : 0

    return {
      invoiceId: inv.id,
      number: inv.number,
      customerId: inv.customer.id,
      customerName: inv.customer.name,
      projectName: inv.project?.name ?? null,
      date: inv.date,
      dueDate: inv.dueDate,
      currency: inv.currency,
      grandTotal, received, tdsCredited, tdsExpected, collectible,
      daysOverdue,
      bucket: daysOverdue === 0 ? 'current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+',
    }
  })
}

export async function arSummary(ctx: RequestContext, asOf = new Date()) {
  const rows = await arAgeing(ctx, asOf)
  const buckets: Record<AgeingRow['bucket'], Decimal> = {
    current: ZERO, '1-30': ZERO, '31-60': ZERO, '61-90': ZERO, '90+': ZERO,
  }
  let total = ZERO, tdsExpected = ZERO, overdueCount = 0
  for (const r of rows) {
    buckets[r.bucket] = buckets[r.bucket].plus(r.collectible)
    total = total.plus(r.collectible)
    tdsExpected = tdsExpected.plus(r.tdsExpected)
    if (r.daysOverdue > 0) overdueCount++
  }
  return { rows, buckets, total, tdsExpected, overdueCount, invoiceCount: rows.length }
}
