import { prisma } from '@/server/db'
import { Decimal, ZERO, sumBy } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { accountBalances, type Period } from './ledger'

export type CfBucket = 'OPERATING' | 'INVESTING' | 'FINANCING'

export interface CfLine { code: string; name: string; inflow: Decimal; outflow: Decimal; net: Decimal }
export interface CfSection { bucket: CfBucket; label: string; lines: CfLine[]; net: Decimal }

export interface CashFlow {
  period: Period
  opening: Decimal
  sections: CfSection[]
  netChange: Decimal
  closing: Decimal
  /** 🔴 derived movement vs the actual cash account balance — must agree */
  reconciles: boolean
  difference: Decimal
}

/**
 * Classify by the OTHER side of the entry. A bank line on its own says nothing about
 * whether cash moved for operations or for financing — the contra account does.
 */
function bucketFor(code: string, type: string): CfBucket {
  if (code.startsWith('15')) return 'INVESTING'              // fixed assets
  if (code.startsWith('30') || code.startsWith('31')) return 'FINANCING'  // share capital, retained earnings
  if (code === '2500') return 'FINANCING'                    // director's current account
  if (type === 'INCOME' || type === 'EXPENSE') return 'OPERATING'
  return 'OPERATING'                                          // AR, AP, GST, TDS, payroll liabilities
}

const LABELS: Record<CfBucket, string> = {
  OPERATING: 'Operating activities',
  INVESTING: 'Investing activities',
  FINANCING: 'Financing activities',
}

/**
 * Direct method, built from what actually moved through the bank and cash accounts.
 *
 * The indirect method starts from profit and adjusts it, which needs a prior-period
 * balance sheet and is impossible to check by eye. The direct method here is verifiable
 * against the statement Adpedia can download from Axis — and after phase 7 those
 * movements are the reconciled ones, so the two agree by construction.
 */
export async function cashFlow(ctx: RequestContext, period: Period): Promise<CashFlow> {
  assertCan(ctx.role, 'reports', 'read')

  const cashAccounts = await prisma.account.findMany({
    where: { companyId: ctx.companyId, subType: { in: ['BANK', 'CASH'] } },
    select: { id: true, code: true },
  })
  const cashIds = cashAccounts.map((a) => a.id)

  const balances = await accountBalances(ctx, period, { includeZero: true })
  const cashCodes = new Set(cashAccounts.map((a) => a.code))
  const opening = sumBy(balances.filter((b) => cashCodes.has(b.code)), (b) => b.opening)

  if (cashIds.length === 0) {
    return { period, opening: ZERO, sections: [], netChange: ZERO, closing: ZERO, reconciles: true, difference: ZERO }
  }

  // every entry that touched cash in the window, with ALL its lines so we can see the contra
  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId: ctx.companyId,
      date: { gte: period.from, lte: period.to },
      lines: { some: { accountId: { in: cashIds } } },
    },
    include: { lines: { include: { account: { select: { code: true, name: true, type: true, subType: true } } } } },
  })

  const agg = new Map<string, { code: string; name: string; bucket: CfBucket; inflow: Decimal; outflow: Decimal }>()
  let netChange = ZERO

  for (const e of entries) {
    const cashLines = e.lines.filter((l) => cashIds.includes(l.accountId))
    const otherLines = e.lines.filter((l) => !cashIds.includes(l.accountId))

    // how much cash this entry moved, net
    const cashDelta = cashLines.reduce(
      (acc, l) => acc.plus(l.debit.toString()).minus(l.credit.toString()), ZERO)
    if (cashDelta.isZero()) continue  // a pure contra between two own accounts moves no cash
    netChange = netChange.plus(cashDelta)

    // 🔴 Attribute only to legs on the OPPOSITE side of the cash movement.
    //
    // A receipt posts Dr Bank 1,08,000 / Dr TDS Receivable 10,000 / Cr AR 1,18,000. The TDS
    // leg is a debit, the same side as the cash — it did not fund the inflow, it is a second
    // non-cash application of the same settlement. Spreading across every non-cash leg would
    // report ₹8,437 of cash "received against TDS Receivable", which never happened.
    // The totals tie either way, so this error hides in a report that looks correct.
    const fundingSide = otherLines.filter((l) =>
      cashDelta.gt(0) ? new Decimal(l.credit.toString()).gt(0) : new Decimal(l.debit.toString()).gt(0))
    const attributable = fundingSide.length > 0 ? fundingSide : otherLines

    const weightOf = (l: (typeof otherLines)[number]) =>
      fundingSide.length > 0
        ? new Decimal((cashDelta.gt(0) ? l.credit : l.debit).toString())
        : new Decimal(l.debit.toString()).plus(l.credit.toString())

    const totalOther = attributable.reduce((acc, l) => acc.plus(weightOf(l)), ZERO)

    for (const l of attributable) {
      const weight = weightOf(l)
      if (weight.isZero() || totalOther.isZero()) continue
      const share = cashDelta.mul(weight).div(totalOther)
      const key = l.account.code
      const row = agg.get(key) ?? {
        code: l.account.code, name: l.account.name,
        bucket: bucketFor(l.account.code, l.account.type),
        inflow: ZERO, outflow: ZERO,
      }
      if (share.gt(0)) row.inflow = row.inflow.plus(share)
      else row.outflow = row.outflow.plus(share.abs())
      agg.set(key, row)
    }
  }

  const sections: CfSection[] = (['OPERATING', 'INVESTING', 'FINANCING'] as CfBucket[])
    .map((bucket) => {
      const lines = [...agg.values()]
        .filter((r) => r.bucket === bucket)
        .map((r) => ({ code: r.code, name: r.name, inflow: r.inflow, outflow: r.outflow, net: r.inflow.minus(r.outflow) }))
        .sort((a, b) => a.code.localeCompare(b.code))
      return { bucket, label: LABELS[bucket], lines, net: sumBy(lines, (l) => l.net) }
    })
    .filter((s) => s.lines.length > 0)

  const closing = opening.plus(netChange)
  const actualClosing = sumBy(balances.filter((b) => cashCodes.has(b.code)), (b) => b.closing)
  const difference = closing.minus(actualClosing)

  return {
    period, opening, sections, netChange, closing,
    reconciles: difference.abs().lte('0.01'), difference,
  }
}
