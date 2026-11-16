import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { certificateDueDate } from './tds-challan'
import { currentFinancialYearOrThrow } from '@/server/services/accounting/period'

export interface ReceivableRow {
  id: string
  customerId: string
  customerName: string
  deductorTan: string | null
  sectionCode: string
  quarter: number
  invoiceNumber: string | null
  baseAmount: Decimal
  tdsAmount: Decimal
  form26asAmount: Decimal | null
  variance: Decimal
  bookedOn: Date
  status: string
  form16aReceived: boolean
  ageDays: number
}

const DAY = 86_400_000

/**
 * TDS our CUSTOMERS deducted from us. It is an asset — cash the government already holds
 * on Adpedia's behalf — and it is only claimable in the ITR if it appears in Form 26AS.
 *
 * Unclaimed TDS is money lost outright, not deferred (docs/02 §B1).
 */
export async function receivableAgeing(ctx: RequestContext, financialYearId?: string): Promise<ReceivableRow[]> {
  assertCan(ctx.role, 'tax', 'read')

  const fy = financialYearId
    ? await prisma.financialYear.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: financialYearId } })
    : await currentFinancialYearOrThrow(ctx.companyId)

  const rows = await prisma.tdsReceivable.findMany({
    where: { companyId: ctx.companyId, financialYearId: fy.id },
    include: { invoice: { select: { number: true } } },
    orderBy: [{ quarter: 'asc' }, { bookedOn: 'asc' }],
  })

  const customers = await prisma.customer.findMany({
    where: { companyId: ctx.companyId, id: { in: [...new Set(rows.map((r) => r.customerId))] } },
    select: { id: true, name: true, tan: true },
  })
  const byId = new Map(customers.map((c) => [c.id, c]))
  const today = new Date()

  return rows.map((r) => {
    const tds = new Decimal(r.tdsAmount.toString())
    const in26as = r.form26asAmount ? new Decimal(r.form26asAmount.toString()) : null
    const c = byId.get(r.customerId)
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: c?.name ?? 'Unknown',
      deductorTan: r.deductorTan ?? c?.tan ?? null,
      sectionCode: r.sectionCode,
      quarter: r.quarter,
      invoiceNumber: r.invoice?.number ?? null,
      baseAmount: new Decimal(r.baseAmount.toString()),
      tdsAmount: tds,
      form26asAmount: in26as,
      variance: in26as ? in26as.minus(tds) : tds.negated(),
      bookedOn: r.bookedOn,
      status: r.status,
      form16aReceived: r.form16aReceived,
      ageDays: Math.floor((today.getTime() - r.bookedOn.getTime()) / DAY),
    }
  })
}

export async function receivableSummary(ctx: RequestContext, financialYearId?: string) {
  const rows = await receivableAgeing(ctx, financialYearId)

  const byQuarter = new Map<number, { booked: Decimal; matched: Decimal; missing: Decimal; count: number }>()
  const byCustomer = new Map<string, { name: string; booked: Decimal; matched: Decimal; missing: Decimal; tan: string | null; noForm16a: number }>()
  const bySection = new Map<string, Decimal>()

  let booked = ZERO, matched = ZERO, missing = ZERO
  for (const r of rows) {
    booked = booked.plus(r.tdsAmount)
    const isMatched = r.status === 'MATCHED_26AS' || r.status === 'CLAIMED'
    if (isMatched) matched = matched.plus(r.tdsAmount)
    else missing = missing.plus(r.tdsAmount)

    const q = byQuarter.get(r.quarter) ?? { booked: ZERO, matched: ZERO, missing: ZERO, count: 0 }
    byQuarter.set(r.quarter, {
      booked: q.booked.plus(r.tdsAmount),
      matched: isMatched ? q.matched.plus(r.tdsAmount) : q.matched,
      missing: isMatched ? q.missing : q.missing.plus(r.tdsAmount),
      count: q.count + 1,
    })

    const c = byCustomer.get(r.customerId) ?? { name: r.customerName, booked: ZERO, matched: ZERO, missing: ZERO, tan: r.deductorTan, noForm16a: 0 }
    byCustomer.set(r.customerId, {
      ...c,
      booked: c.booked.plus(r.tdsAmount),
      matched: isMatched ? c.matched.plus(r.tdsAmount) : c.matched,
      missing: isMatched ? c.missing : c.missing.plus(r.tdsAmount),
      noForm16a: c.noForm16a + (r.form16aReceived ? 0 : 1),
    })

    bySection.set(r.sectionCode, (bySection.get(r.sectionCode) ?? ZERO).plus(r.tdsAmount))
  }

  return {
    rows, booked, matched, missing,
    byQuarter: [...byQuarter.entries()].map(([quarter, v]) => ({ quarter, ...v })).sort((a, b) => a.quarter - b.quarter),
    byCustomer: [...byCustomer.entries()].map(([id, v]) => ({ customerId: id, ...v })).sort((a, b) => b.missing.minus(a.missing).toNumber()),
    bySection: [...bySection.entries()].map(([section, amount]) => ({ section, amount })),
  }
}

/** Clients who have deducted but not yet issued the certificate. */
export async function form16aChaseList(ctx: RequestContext, financialYearId?: string) {
  const { rows } = await receivableSummary(ctx, financialYearId)
  const fy = financialYearId
    ? await prisma.financialYear.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: financialYearId } })
    : await currentFinancialYearOrThrow(ctx.companyId)
  const fyStartYear = Number(fy.label.split('-')[0])
  const today = new Date()

  const byCustomer = new Map<string, { name: string; tan: string | null; quarters: Set<number>; amount: Decimal; overdueQuarters: number[] }>()
  for (const r of rows) {
    if (r.form16aReceived) continue
    const e = byCustomer.get(r.customerId) ?? { name: r.customerName, tan: r.deductorTan, quarters: new Set<number>(), amount: ZERO, overdueQuarters: [] }
    e.quarters.add(r.quarter)
    e.amount = e.amount.plus(r.tdsAmount)
    const due = certificateDueDate(fyStartYear, r.quarter as 1 | 2 | 3 | 4)
    if (today > due && !e.overdueQuarters.includes(r.quarter)) e.overdueQuarters.push(r.quarter)
    byCustomer.set(r.customerId, e)
  }

  return [...byCustomer.entries()].map(([customerId, e]) => ({
    customerId, name: e.name, tan: e.tan,
    quarters: [...e.quarters].sort(),
    overdueQuarters: e.overdueQuarters.sort(),
    amount: e.amount,
    message: `${e.name} deducted ${formatINR(e.amount)} across Q${[...e.quarters].sort().join(', Q')} but has not issued Form 16A${e.overdueQuarters.length ? ` — Q${e.overdueQuarters.join(', Q')} ${e.overdueQuarters.length === 1 ? 'is' : 'are'} past the 15-day deadline` : ''}.`,
  })).sort((a, b) => b.amount.minus(a.amount).toNumber())
}

export async function markForm16aReceived(ctx: RequestContext, receivableIds: string[], received = true) {
  assertCan(ctx.role, 'tax', 'write')
  await prisma.tdsReceivable.updateMany({
    where: { id: { in: receivableIds }, companyId: ctx.companyId },
    data: { form16aReceived: received },
  })
}
