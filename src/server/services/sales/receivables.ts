import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { noteTotals } from '@/server/services/invoicing/notes'
import { inrOf } from '@/lib/fx'

export interface AgeingRow {
  invoiceId: string
  number: string
  customerId: string
  customerName: string
  projectName: string | null
  date: Date
  dueDate: Date
  currency: string
  /** the invoice as issued */
  grandTotal: Decimal
  /** live credit notes against it, gross */
  credited: Decimal
  /** live debit notes against it, gross */
  debited: Decimal
  /** the invoice as it now stands — docs/86. This is the figure 1100 carries. */
  gross: Decimal
  received: Decimal
  tdsCredited: Decimal
  /** gross less what has been settled — what this invoice contributes to 1100 */
  outstanding: Decimal
  /** TDS the customer is expected to deduct but has not yet paid over */
  tdsExpected: Decimal
  /** cash we can still actually collect */
  collectible: Decimal
  /**
   * docs/91 — the rupees this invoice is carried at in the books (the figures above are in
   * `currency`). The summary adds THESE; adding the document-currency ones put dollars into a
   * rupee total.
   */
  collectibleInr: Decimal
  tdsExpectedInr: Decimal
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
 * So: collectible = gross − received − tdsCredited − tdsStillExpected.
 *
 * 🔴 `gross` is the invoice NET OF ITS CREDIT NOTES, and plus its debit notes — docs/86. It
 * was `grandTotal`, which is the invoice as issued, so every credit note this company raised
 * stayed in the ageing for ever and the total disagreed with 1100 Accounts Receivable.
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
  const notes = await noteTotals(ctx.companyId, invoices.map((i) => i.id))

  return invoices.map((inv) => {
    const open = invoiceOpen(inv, notes.get(inv.id) ?? NO_NOTES)
    const { issued: grandTotal, credited, debited, gross } = open
    const { received, tdsCredited, outstanding, tdsExpected, collectible } = open

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
      grandTotal, credited, debited, gross, received, tdsCredited, outstanding, tdsExpected, collectible,
      collectibleInr: inrOf(inv, collectible), tdsExpectedInr: inrOf(inv, tdsExpected),
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
    buckets[r.bucket] = buckets[r.bucket].plus(r.collectibleInr)
    total = total.plus(r.collectibleInr)
    tdsExpected = tdsExpected.plus(r.tdsExpectedInr)
    if (r.daysOverdue > 0) overdueCount++
  }
  return { rows, buckets, total, tdsExpected, overdueCount, invoiceCount: rows.length }
}
