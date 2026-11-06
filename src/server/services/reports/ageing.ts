import { prisma } from '@/server/db'
import { Decimal, ZERO, sumBy } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { noteTotals } from '@/server/services/invoicing/notes'
import { inrOf } from '@/lib/fx'
import { outstandingInr } from '@/lib/bill-fx'

export const BUCKETS = ['Not due', '1–30', '31–60', '61–90', '90+'] as const
export type Bucket = typeof BUCKETS[number]

export interface AgeingDoc {
  id: string
  number: string
  partyId: string
  partyName: string
  date: Date
  dueDate: Date
  daysOverdue: number
  bucket: Bucket
  outstanding: Decimal
  /** AR only: deducted at source, so it will never arrive as cash from this party */
  tdsWithheld: Decimal
}

export interface AgeingParty {
  partyId: string
  partyName: string
  buckets: Record<Bucket, Decimal>
  total: Decimal
  docs: AgeingDoc[]
}

export interface Ageing {
  asOf: Date
  parties: AgeingParty[]
  totals: Record<Bucket, Decimal>
  grandTotal: Decimal
  /** AR only — what is owed but is a government credit, not a client debt */
  tdsWithheldTotal: Decimal
}

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return 'Not due'
  if (daysOverdue <= 30) return '1–30'
  if (daysOverdue <= 60) return '31–60'
  if (daysOverdue <= 90) return '61–90'
  return '90+'
}

function emptyBuckets(): Record<Bucket, Decimal> {
  return { 'Not due': ZERO, '1–30': ZERO, '31–60': ZERO, '61–90': ZERO, '90+': ZERO }
}

function assemble(docs: AgeingDoc[], asOf: Date): Ageing {
  const byParty = new Map<string, AgeingParty>()
  const totals = emptyBuckets()

  for (const d of docs) {
    const p = byParty.get(d.partyId) ?? { partyId: d.partyId, partyName: d.partyName, buckets: emptyBuckets(), total: ZERO, docs: [] }
    p.buckets[d.bucket] = p.buckets[d.bucket].plus(d.outstanding)
    p.total = p.total.plus(d.outstanding)
    p.docs.push(d)
    byParty.set(d.partyId, p)
    totals[d.bucket] = totals[d.bucket].plus(d.outstanding)
  }

  const parties = [...byParty.values()].sort((a, b) => b.total.comparedTo(a.total))
  return {
    asOf, parties, totals,
    grandTotal: sumBy(docs, (d) => d.outstanding),
    tdsWithheldTotal: sumBy(docs, (d) => d.tdsWithheld),
  }
}

const DAY = 86_400_000

/**
 * Receivables ageing.
 *
 * 🔴 Outstanding is net of the TDS the client is expected to withhold. Ageing an invoice
 * at its gross value overstates the debt by exactly the tax — the client is never going to
 * send that money, because they are required to pay it to the government instead. Chasing
 * a customer for it is chasing a payment that cannot legally be made. The withheld amount
 * is reported separately: it is a receivable, but from the government, and it is collected
 * by getting it onto Form 26AS (phase 6), not by a reminder email.
 */
export async function receivablesAgeing(ctx: RequestContext, asOf: Date = new Date()): Promise<Ageing> {
  assertCan(ctx.role, 'reports', 'read')

  const invoices = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] } },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  // 🔴 net of the credit notes raised against them, and plus the debit notes — docs/86
  const notes = await noteTotals(ctx.companyId, invoices.map((i) => i.id))

  const docs: AgeingDoc[] = invoices.flatMap((i) => {
    const open = invoiceOpen(i, notes.get(i.id) ?? NO_NOTES)
    if (open.collectible.lte(0)) return []
    const daysOverdue = Math.floor((asOf.getTime() - i.dueDate.getTime()) / DAY)
    return [{
      id: i.id, number: i.number, partyId: i.customer.id, partyName: i.customer.name,
      date: i.date, dueDate: i.dueDate, daysOverdue, bucket: bucketFor(daysOverdue),
      // docs/91 — rupees at the invoice's rate, so this adds up to 1100 and not to dollars + rupees
      outstanding: inrOf(i, open.collectible), tdsWithheld: inrOf(i, open.tdsExpected),
    }]
  })

  return assemble(docs, asOf)
}

/**
 * Payables ageing. The mirror image: what Adpedia owes is net of the TDS it withholds,
 * because that part is owed to the government on the 7th, not to the vendor.
 */
export async function payablesAgeing(ctx: RequestContext, asOf: Date = new Date()): Promise<Ageing> {
  assertCan(ctx.role, 'reports', 'read')

  const bills = await prisma.vendorBill.findMany({
    where: { companyId: ctx.companyId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  const docs: AgeingDoc[] = bills.flatMap((b) => {
    const tds = new Decimal(b.tdsAmount.toString())
    const outstanding = new Decimal(b.grandTotal.toString()).minus(tds).minus(b.amountPaid.toString())
    if (outstanding.lte(0)) return []
    const daysOverdue = Math.floor((asOf.getTime() - b.dueDate.getTime()) / DAY)
    return [{
      id: b.id, number: b.billNumber, partyId: b.vendor.id, partyName: b.vendor.name,
      date: b.billDate, dueDate: b.dueDate, daysOverdue, bucket: bucketFor(daysOverdue),
      // docs/93 — rupees as payables carries them
      outstanding: outstandingInr(b, outstanding), tdsWithheld: new Decimal((b.tdsAmountInr ?? b.tdsAmount).toString()),
    }]
  })

  return assemble(docs, asOf)
}
