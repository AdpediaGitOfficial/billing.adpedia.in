import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import { inrOf } from '@/lib/fx'
import type { RequestContext } from '@/server/context'
import { arSummary } from '@/server/services/sales/receivables'
import { currentFinancialYear } from '@/server/services/accounting/period'

export interface ComplianceAlert {
  id: string
  tone: 'critical' | 'warn' | 'info'
  title: string
  detail: string
  href?: string
}

/**
 * The "needs you" list. Everything here is derived from real state — if there is
 * nothing wrong, the list is empty and the dashboard says so.
 */
export async function complianceAlerts(companyId: string): Promise<ComplianceAlert[]> {
  const out: ComplianceAlert[] = []
  const fy = await currentFinancialYear(companyId)
  if (!fy) return out

  // 1. a LUT is needed for the current year before anything can be exported zero-rated
  const [lut, exportCustomers] = await Promise.all([
    prisma.companyLut.findFirst({ where: { companyId, fyLabel: fy.label } }),
    prisma.customer.count({ where: { companyId, country: { not: 'IN' }, isActive: true } }),
  ])
  if (!lut && exportCustomers > 0) {
    out.push({
      id: 'lut', tone: 'critical',
      title: `No LUT on file for FY ${fy.label}`,
      detail: `${exportCustomers} overseas ${exportCustomers === 1 ? 'customer' : 'customers'} on record. Export invoices are blocked until Form RFD-11 is filed.`,
    })
  }

  // 2. freelancers without a verified PAN are deducted at 20% under s.206AA
  const noPan = await prisma.vendor.count({ where: { companyId, isActive: true, defaultTdsSection: { not: null }, OR: [{ pan: null }, { panVerified: false }] } })
  if (noPan > 0) {
    out.push({
      id: 'pan', tone: 'warn',
      title: `${noPan} ${noPan === 1 ? 'vendor has' : 'vendors have'} no PAN on file`,
      detail: 'Section 206AA forces TDS at 20% instead of the normal rate until a PAN is on file.',
      href: '/vendors',
    })
  }

  // 3. TDS deducted but not yet linked to a challan
  const unlinked = await prisma.tdsDeduction.count({ where: { companyId, challanId: null } })
  if (unlinked > 0) {
    out.push({
      id: 'tds', tone: 'warn',
      title: `${unlinked} TDS ${unlinked === 1 ? 'deduction' : 'deductions'} not yet deposited`,
      detail: 'Due by the 7th of the following month. Interest runs at 1.5% per month after that.',
      href: '/tax/tds',
    })
  }

  // 4. TDS clients deducted that has never appeared in 26AS — unclaimable, so lost
  const missing26as = await prisma.tdsReceivable.aggregate({
    where: { companyId, status: 'MISSING_IN_26AS' },
    _sum: { tdsAmount: true }, _count: true,
  })
  if (missing26as._count > 0) {
    out.push({
      id: 'tds-rec', tone: 'critical',
      title: `₹${Number(missing26as._sum.tdsAmount ?? 0).toLocaleString('en-IN')} of TDS is missing from Form 26AS`,
      detail: `${missing26as._count} deduction${missing26as._count === 1 ? '' : 's'} a client kept but has not filed. A credit that never reaches 26AS cannot be claimed — it is lost, not deferred.`,
      href: '/tax/tds-receivable',
    })
  }

  // 5. drafts sitting unsent
  const drafts = await prisma.invoice.count({ where: { companyId, status: 'DRAFT' } })
  if (drafts > 0) {
    out.push({
      id: 'drafts', tone: 'info',
      title: `${drafts} invoice ${drafts === 1 ? 'draft' : 'drafts'} unsent`,
      detail: 'A draft has no number and posts nothing to the ledger until it is sent.',
      href: '/invoices',
    })
  }

  return out
}

/** Monthly revenue and cash received, for the trend chart. Real postings only. */
export async function monthlySeries(companyId: string, fyId: string) {
  const fy = await prisma.financialYear.findUniqueOrThrow({ where: { id: fyId } })
  const invoices = await prisma.invoice.findMany({
    where: { companyId, financialYearId: fyId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: { date: true, currency: true, fxRate: true, taxableValue: true, amountReceived: true },
  })

  const months: { label: string; values: number[] }[] = []
  for (let m = 0; m < 12; m++) {
    const d = new Date(Date.UTC(fy.startsOn.getUTCFullYear(), fy.startsOn.getUTCMonth() + m, 1))
    if (d > new Date()) break
    const inMonth = invoices.filter((i) => i.date.getUTCFullYear() === d.getUTCFullYear() && i.date.getUTCMonth() === d.getUTCMonth())
    months.push({
      label: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      values: [
        // docs/91 — rupees at each invoice's own rate; adding dollars to rupees was the defect
        inMonth.reduce((a, i) => a + Number(inrOf(i, i.taxableValue.toString())), 0),
        inMonth.reduce((a, i) => a + Number(inrOf(i, i.amountReceived.toString())), 0),
      ],
    })
  }
  return months
}

export async function revenueByCustomer(companyId: string, fyId: string) {
  // docs/91 — read per invoice, not grouped in the database: a sum cannot apply each invoice's own rate
  const invoices = await prisma.invoice.findMany({
    where: { companyId, financialYearId: fyId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: { customerId: true, currency: true, fxRate: true, taxableValue: true },
  })
  if (invoices.length === 0) return []
  const totals = new Map<string, number>()
  for (const i of invoices) {
    totals.set(i.customerId, (totals.get(i.customerId) ?? 0) + Number(inrOf(i, i.taxableValue.toString())))
  }
  const names = await prisma.customer.findMany({ where: { id: { in: [...totals.keys()] } }, select: { id: true, name: true } })
  const byId = new Map(names.map((n) => [n.id, n.name]))
  return [...totals]
    .map(([customerId, value]) => ({ label: byId.get(customerId) ?? 'Unknown', value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)
}

export async function dashboardSummary(ctx: RequestContext) {
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return null

  const [ar, invoices, receipts, bank, series, byCustomer, alerts] = await Promise.all([
    arSummary(ctx),
    prisma.invoice.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      select: { currency: true, fxRate: true, taxableValue: true, grandTotal: true, cgst: true, sgst: true, igst: true },
    }),
    // 🔴 cancelled receipts are excluded, or money that was reversed still reads as collected
    // docs/91 — a foreign receipt counts as the rupees the bank credited, not its dollars
    prisma.receipt.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id, cancelledAt: null },
      select: { amount: true, inrAmount: true, tdsAmount: true },
    }),
    prisma.companyBankAccount.findFirst({ where: { companyId: ctx.companyId, isDefault: true }, select: { label: true, accountNo: true } }),
    monthlySeries(ctx.companyId, fy.id),
    revenueByCustomer(ctx.companyId, fy.id),
    complianceAlerts(ctx.companyId),
  ])

  // docs/91 — every invoice figure in rupees at its own rate
  const sumInr = (pick: (i: (typeof invoices)[number]) => Decimal.Value) =>
    invoices.reduce((a, i) => a.plus(inrOf(i, pick(i))), ZERO)
  const outputGst = sumInr((i) => new Decimal(i.cgst.toString()).plus(i.sgst.toString()).plus(i.igst.toString()))

  return {
    fy,
    revenue: sumInr((i) => i.taxableValue.toString()),
    invoiced: sumInr((i) => i.grandTotal.toString()),
    invoiceCount: invoices.length,
    collected: receipts.reduce((a, r) => a.plus((r.inrAmount ?? r.amount).toString()), ZERO),
    tdsCredited: receipts.reduce((a, r) => a.plus(r.tdsAmount.toString()), ZERO),
    outputGst,
    receivable: ar.total,
    tdsExpected: ar.tdsExpected,
    overdueCount: ar.overdueCount,
    openInvoices: ar.invoiceCount,
    buckets: ar.buckets,
    bank,
    series,
    byCustomer,
    alerts,
    zero: ZERO,
  }
}
