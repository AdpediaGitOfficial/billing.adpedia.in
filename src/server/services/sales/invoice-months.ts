import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { fyBounds } from '@/lib/fy'

/**
 * What was billed, month by month — docs/83 §7.
 *
 * 🔴 The list could be read by invoice and the stat tiles by financial year, and there was
 * nothing in between. "What did we bill in July" meant paging through a list ordered by date
 * and adding it up by eye, and "is anything missing from August" could not be asked at all.
 *
 * This is the GST view of the books as well as the admin one: GSTR-1 is filed per month
 * (per quarter under QRMP, docs/23), so the month is the period the return is about, and a
 * month whose total here does not match the return is the first thing to look at.
 */
export interface InvoiceMonth {
  /** `2026-11` — the query-string value, and a stable key */
  key: string
  /** `Nov 2026` */
  label: string
  /** 🔴 true for the month the financial year is currently in — it is not closed yet */
  current: boolean
  /** issued documents, excluding cancelled ones */
  issued: number
  /** 🔴 counted and NOT added up: a cancelled invoice has been reversed */
  cancelled: number
  /** 🔴 not an invoice yet; it has taken no number and posted nothing */
  drafts: number
  taxableValue: Decimal
  gst: Decimal
  grandTotal: Decimal
  received: Decimal
  /**
   * What is still collectible out of this month — docs/02 §B1, the same definition
   * `arAgeing` uses.
   *
   * 🔴 grandTotal − received − TDS credited − TDS still expected. The last term is the one
   * that is easy to drop: a ₹59,000 invoice on which the customer will deduct ₹5,000 of TDS
   * is fully settled by ₹54,000, so counting the ₹5,000 as outstanding makes a paid month
   * look permanently short. The first version of this omitted it and the month total came out
   * ₹5,000 above the Collectible tile on the same screen — two figures that both read as
   * "what is owed", differing, which is the "two balances with the same name" of docs/56 §2.
   */
  outstanding: Decimal
  /**
   * 🔴 Invoices in this month NOT in rupees, counted rather than converted.
   *
   * `Invoice.fxRate` exists in the schema and is read nowhere in the application — it is
   * another field nothing binds (docs/67 §2), so it is 1 on every row including the exports.
   * Adding a USD grand total to a rupee column at a rate of 1 would produce a month figure
   * that is wrong by two orders of magnitude and looks like a number. So the rupee columns
   * are rupees only, and anything else is named here.
   */
  foreignCurrency: { currency: string; count: number }[]
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const keyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

/** The bounds of a `2026-11` key, as the UTC instants the invoice dates are stored at. */
export function monthBounds(key: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]) - 1
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)) }
}

export function monthLabel(key: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key)
  return m ? `${MONTH[Number(m[2]) - 1]} ${m[1]}` : key
}

export async function invoicesByMonth(
  ctx: RequestContext,
  fyLabel: string,
  now = new Date(),
): Promise<InvoiceMonth[]> {
  assertCan(ctx.role, 'invoices', 'read')
  const { startsOn, endsOn } = fyBounds(fyLabel)

  const invoices = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, date: { gte: startsOn, lte: endsOn } },
    select: {
      date: true, status: true, cancelledAt: true, currency: true,
      taxableValue: true, cgst: true, sgst: true, igst: true, grandTotal: true,
      amountReceived: true, tdsCredited: true, tdsAmount: true,
    },
  })

  /**
   * 🔴 EVERY month of the financial year, including the empty ones.
   *
   * A list that skips a month with no invoices answers "what did we bill in July" with
   * silence, and silence reads the same as not having looked. The whole argument of docs/64 —
   * a gap has to be visible before anybody can explain it.
   */
  const months = new Map<string, InvoiceMonth>()
  for (let d = new Date(startsOn); d < endsOn; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = keyOf(d)
    months.set(key, {
      key, label: monthLabel(key), current: key === keyOf(now),
      issued: 0, cancelled: 0, drafts: 0,
      taxableValue: ZERO, gst: ZERO, grandTotal: ZERO, received: ZERO, outstanding: ZERO,
      foreignCurrency: [],
    })
  }

  const foreign = new Map<string, Map<string, number>>()

  for (const inv of invoices) {
    const row = months.get(keyOf(inv.date))
    if (!row) continue   // a date outside the year's own months cannot happen, but is not assumed

    if (inv.status === 'DRAFT') { row.drafts++; continue }
    if (inv.cancelledAt) { row.cancelled++; continue }

    row.issued++

    if (inv.currency !== 'INR') {
      const byCur = foreign.get(row.key) ?? new Map<string, number>()
      byCur.set(inv.currency, (byCur.get(inv.currency) ?? 0) + 1)
      foreign.set(row.key, byCur)
      continue
    }

    const grandTotal = new Decimal(inv.grandTotal.toString())
    const received = new Decimal(inv.amountReceived.toString())
    const tdsCredited = new Decimal(inv.tdsCredited.toString())

    row.taxableValue = row.taxableValue.plus(inv.taxableValue.toString())
    row.gst = row.gst.plus(inv.cgst.toString()).plus(inv.sgst.toString()).plus(inv.igst.toString())
    row.grandTotal = row.grandTotal.plus(grandTotal)
    row.received = row.received.plus(received)
    // the portion of the expected TDS not yet credited — it never arrives as cash
    const tdsExpected = Decimal.max(new Decimal(inv.tdsAmount.toString()).minus(tdsCredited), ZERO)
    row.outstanding = row.outstanding.plus(
      Decimal.max(grandTotal.minus(received).minus(tdsCredited).minus(tdsExpected), ZERO),
    )
  }

  for (const [key, byCur] of foreign) {
    months.get(key)!.foreignCurrency = [...byCur].map(([currency, count]) => ({ currency, count }))
  }

  return [...months.values()]
}
