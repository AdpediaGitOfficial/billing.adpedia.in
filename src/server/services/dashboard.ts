import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
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
    select: { date: true, taxableValue: true, amountReceived: true },
  })

  const months: { label: string; values: number[] }[] = []
  for (let m = 0; m < 12; m++) {
    const d = new Date(Date.UTC(fy.startsOn.getUTCFullYear(), fy.startsOn.getUTCMonth() + m, 1))
    if (d > new Date()) break
    const inMonth = invoices.filter((i) => i.date.getUTCFullYear() === d.getUTCFullYear() && i.date.getUTCMonth() === d.getUTCMonth())
    months.push({
      label: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
      values: [
        inMonth.reduce((a, i) => a + Number(i.taxableValue), 0),
        inMonth.reduce((a, i) => a + Number(i.amountReceived), 0),
      ],
    })
  }
  return months
}

export async function revenueByCustomer(companyId: string, fyId: string) {
  const rows = await prisma.invoice.groupBy({
    by: ['customerId'],
    where: { companyId, financialYearId: fyId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    _sum: { taxableValue: true },
  })
  if (rows.length === 0) return []
  const names = await prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true } })
  const byId = new Map(names.map((n) => [n.id, n.name]))
  return rows
    .map((r) => ({ label: byId.get(r.customerId) ?? 'Unknown', value: Number(r._sum.taxableValue ?? 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)
}

export async function dashboardSummary(ctx: RequestContext) {
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return null

  const [ar, invoices, receipts, bank, series, byCustomer, alerts] = await Promise.all([
    arSummary(ctx),
    prisma.invoice.aggregate({
      where: { companyId: ctx.companyId, financialYearId: fy.id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { taxableValue: true, grandTotal: true, cgst: true, sgst: true, igst: true }, _count: true,
    }),
    // 🔴 cancelled receipts are excluded, or money that was reversed still reads as collected
    prisma.receipt.aggregate({ where: { companyId: ctx.companyId, financialYearId: fy.id, cancelledAt: null }, _sum: { amount: true, tdsAmount: true } }),
    prisma.companyBankAccount.findFirst({ where: { companyId: ctx.companyId, isDefault: true }, select: { label: true, accountNo: true } }),
    monthlySeries(ctx.companyId, fy.id),
    revenueByCustomer(ctx.companyId, fy.id),
    complianceAlerts(ctx.companyId),
  ])

  const outputGst = new Decimal(invoices._sum.cgst?.toString() ?? 0)
    .plus(invoices._sum.sgst?.toString() ?? 0)
    .plus(invoices._sum.igst?.toString() ?? 0)

  return {
    fy,
    revenue: new Decimal(invoices._sum.taxableValue?.toString() ?? 0),
    invoiced: new Decimal(invoices._sum.grandTotal?.toString() ?? 0),
    invoiceCount: invoices._count,
    collected: new Decimal(receipts._sum.amount?.toString() ?? 0),
    tdsCredited: new Decimal(receipts._sum.tdsAmount?.toString() ?? 0),
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
