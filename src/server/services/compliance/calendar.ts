import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { filedPeriods } from '@/server/services/tax/gst-filing'
import { paidPeriods } from '@/server/services/tax/gst-payment'
import { dischargedPeriods } from '@/server/services/tax/gst-setoff'
import { filedTdsQuarters, formForSectionCode } from '@/server/services/tax/tds-filing'
import { certificatesOutstanding } from '@/server/services/tax/tds-certificate'
import { periodFor } from '@/server/services/tax/periods'
import { currentFinancialYear } from '@/server/services/accounting/period'
import {
  tdsDepositDue, tdsReturnDue, form16aDue, form16Due,
  gstr1Due, gstr3bDue, gstr9Due, professionTaxDue, lutRenewalDue, itrDue,
  type Obligation,
} from './deadlines'

export type CalendarState = 'DONE' | 'DUE' | 'SOON' | 'OVERDUE' | 'NOT_APPLICABLE'

export interface CalendarItem {
  id: string
  obligation: Obligation
  title: string
  detail: string
  dueOn: Date
  state: CalendarState
  daysAway: number
  /** what being late costs, where the law puts a number on it */
  penalty?: string
  href?: string
  amount?: Decimal
}

const DAY = 86_400_000
const SOON_DAYS = 14

/**
 * The compliance calendar.
 *
 * 🔴 Every item is DERIVED FROM DATA, not listed from a table of dates.
 *
 * A calendar that simply prints "GSTR-1 due on the 11th" every month is noise within a
 * fortnight — people stop reading it, and then miss the one that mattered. An item appears
 * here only when there is something to do: TDS to deposit because deductions are unlinked, a
 * return to file because the period has supplies in it, a LUT to renew because exports exist.
 *
 * Where nothing is outstanding the item still shows, marked DONE, because "nothing to do" is
 * itself the answer someone came here for.
 */
export async function complianceCalendar(ctx: RequestContext, now = new Date()): Promise<CalendarItem[]> {
  assertCan(ctx.role, 'tax', 'read')

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    select: { stateCode: true, gstFilingFrequency: true, gstin: true },
  })
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) return []

  const fyStartYear = fy.startsOn.getUTCFullYear()
  const quarterly = company.gstFilingFrequency === 'QUARTERLY'
  const out: CalendarItem[] = []

  const push = (
    item: Omit<CalendarItem, 'state' | 'daysAway'> & { done?: boolean; notApplicable?: boolean },
  ) => {
    const daysAway = Math.ceil((item.dueOn.getTime() - now.getTime()) / DAY)
    const state: CalendarState = item.notApplicable ? 'NOT_APPLICABLE'
      : item.done ? 'DONE'
      : daysAway < 0 ? 'OVERDUE'
      : daysAway <= SOON_DAYS ? 'SOON'
      : 'DUE'
    out.push({ ...item, state, daysAway })
  }

  /* ── TDS deposits, month by month ─────────────────────────────────────────── */

  const deductions = await prisma.tdsDeduction.findMany({
    where: { companyId: ctx.companyId, reversedAt: null, deductedOn: { gte: fy.startsOn, lte: fy.endsOn } },
    select: { deductedOn: true, tdsAmount: true, challanId: true, sectionCode: true },
  })

  const byMonth = new Map<string, { month: number; year: number; unpaid: Decimal; total: Decimal }>()
  for (const d of deductions) {
    const month = d.deductedOn.getUTCMonth() + 1
    const year = d.deductedOn.getUTCFullYear()
    const key = `${year}-${month}`
    const row = byMonth.get(key) ?? { month, year, unpaid: ZERO, total: ZERO }
    const amount = new Decimal(d.tdsAmount.toString())
    row.total = row.total.plus(amount)
    if (!d.challanId) row.unpaid = row.unpaid.plus(amount)
    byMonth.set(key, row)
  }

  for (const row of byMonth.values()) {
    const dueOn = tdsDepositDue(row.month, row.year)
    push({
      id: `tds-deposit-${row.year}-${row.month}`,
      obligation: 'TDS_DEPOSIT',
      title: `Deposit TDS for ${monthName(row.month)} ${row.year}`,
      detail: row.unpaid.isZero()
        ? `All ${fmt(row.total)} deposited`
        : `${fmt(row.unpaid)} deducted and not yet paid to the government`,
      dueOn,
      // 🔴 s.201(1A) runs at 1.5% per month OR PART of a month — a single day late costs a
      // full month's interest, which is why this is stated rather than left to be discovered.
      penalty: '1.5% per month or part of a month under s.201(1A)',
      amount: row.unpaid,
      done: row.unpaid.isZero(),
      href: '/tax/tds',
    })
  }

  /* ── TDS returns and the certificates that follow ─────────────────────────── */

  // 🔴 Which returns have actually been filed — docs/50. Until a filing record existed this
  // item could only ever say "due": nothing knew whether the quarter had gone in, so it
  // nagged forever and the one state that matters — filed, and therefore reported against
  // every deductee's PAN — was invisible.
  const tdsFiled = await filedTdsQuarters(ctx.companyId)
  // docs/55 — how many certificates are actually out, so these items can ever be done
  const certs = await certificatesOutstanding(ctx)

  for (const q of [1, 2, 3, 4] as const) {
    const inQuarter = deductions.filter((d) => quarterOf(d.deductedOn) === q)
    const hasAny = inQuarter.length > 0
    const dueOn = tdsReturnDue(q, fyStartYear)

    // the forms this quarter actually needs, from the sections deducted under
    const forms = [...new Set(inQuarter.map((d) => formForSectionCode(d.sectionCode)))].sort()
    const outstandingForms = forms.filter((f) => !tdsFiled.has(`${f}:${q}`))
    const allFiled = hasAny && outstandingForms.length === 0

    push({
      id: `tds-return-q${q}`,
      obligation: 'TDS_RETURN',
      title: `File TDS return for Q${q}`,
      detail: !hasAny
        ? 'Nothing deducted this quarter — a nil return is still good practice'
        : allFiled
          ? `Filed — ${forms.join(', ')}`
          : `${outstandingForms.join(', ')} still to file · 24Q salary, 26Q residents, 27Q non-residents`,
      dueOn,
      penalty: '₹200 a day under s.234E, capped at the TDS in the return',
      notApplicable: !hasAny,
      done: allFiled,
      href: '/tax/tds',
    })
    if (hasAny) {
      const c = certs.byQuarter.get(q) ?? { total: 0, issued: 0 }
      push({
        id: `form16a-q${q}`,
        obligation: 'FORM_16A',
        title: `Issue Form 16A for Q${q}`,
        detail: c.total === 0
          ? 'Your vendors cannot claim the deduction without it'
          : c.issued === c.total
            ? `All ${c.total} issued`
            : `${c.total - c.issued} of ${c.total} still to issue — download them from TRACES`,
        dueOn: form16aDue(q, fyStartYear),
        penalty: '₹100 a day per certificate under s.272A(2)(g)',
        done: c.total > 0 && c.issued === c.total,
        href: '/tax/tds',
      })
    }
  }

  /* ── Form 16, if anyone is on payroll ─────────────────────────────────────── */

  // still on payroll: nobody who has left needs a Form 16 for a year they were not here
  const employees = await prisma.employee.count({
    where: { companyId: ctx.companyId, OR: [{ leftOn: null }, { leftOn: { gte: fy.startsOn } }] },
  })
  if (employees > 0) {
    push({
      id: 'form16',
      obligation: 'FORM_16',
      title: 'Issue Form 16 to employees',
      detail: certs.form16.total === 0
        ? `${employees} on payroll · nothing deducted yet, so none is due`
        : certs.form16.issued === certs.form16.total
          ? `All ${certs.form16.total} issued`
          : `${certs.form16.total - certs.form16.issued} of ${certs.form16.total} still to issue`,
      dueOn: form16Due(fyStartYear),
      notApplicable: certs.form16.total === 0,
      done: certs.form16.total > 0 && certs.form16.issued === certs.form16.total,
      href: '/tax/tds',
    })
  }

  /* ── GST returns, per filed period ────────────────────────────────────────── */

  if (company.gstin) {
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: ctx.companyId, financialYearId: fy.id,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
      },
      select: { date: true },
    })

    // what has been filed, what has been DEPOSITED, and what has been DISCHARGED — three
    // different states, and the middle one is the trap: a challan sitting unoffset in the
    // cash ledger has settled nothing and is still accruing interest
    const [filed, paid, discharged] = await Promise.all([
      filedPeriods(ctx.companyId),
      paidPeriods(ctx.companyId),
      dischargedPeriods(ctx.companyId),
    ])

    const periods = new Map<string, Date>()
    // 🔴 keyed by the GST PERIOD LABEL, not by date — that is what a filing record carries,
    // and keying by anything else means a filed return never matches its calendar item
    for (const i of invoices) {
      const p = periodFor(i.date, company.gstFilingFrequency)
      periods.set(p.label, p.to)
    }

    for (const [periodLabel, end] of periods) {
      const label = quarterly ? `Q${quarterOf(end)}` : `${monthName(end.getUTCMonth() + 1)} ${end.getUTCFullYear()}`
      const gstr1Filed = filed.has(`GSTR1:${periodLabel}`)
      const gstr3bFiled = filed.has(`GSTR3B:${periodLabel}`)

      push({
        id: `gstr1-${periodLabel}`,
        obligation: 'GSTR1',
        title: `File GSTR-1 for ${label}`,
        detail: gstr1Filed ? 'Filed' : 'Outward supplies, invoice by invoice',
        dueOn: gstr1Due(end, quarterly),
        penalty: '₹50 a day (₹20 for a nil return), capped',
        done: gstr1Filed,
        href: '/tax/gst',
      })
      const gstFunded = paid.has(periodLabel)
      const gstDischarged = discharged.has(periodLabel)
      push({
        id: `gstr3b-${periodLabel}`,
        obligation: 'GSTR3B',
        title: `File GSTR-3B for ${label}`,
        detail: gstr3bFiled ? 'Filed' : 'Summary return, and the one that actually pays the tax',
        dueOn: gstr3bDue(end, quarterly, company.stateCode),
        penalty: 'interest at 18% a year on tax paid late',
        done: gstr3bFiled,
        href: '/tax/gst',
      })
      // 🔴 Its own item. A return recorded as filed with no challan against it used to read
      // as settled; the money is the part that stops the interest running.
      //
      // 🔴 And done means SET OFF, not deposited (docs/46). A challan lying unoffset in the
      // cash ledger has discharged nothing, and rule 88B(1) keeps the interest running until
      // the ledger is actually debited — so treating a deposit as done would hide the cost.
      push({
        id: `gst-payment-${periodLabel}`,
        obligation: 'GSTR3B',
        title: `Pay the GST for ${label}`,
        detail: gstDischarged
          ? 'Set off against the cash and credit ledgers'
          : gstFunded
            ? 'Challan recorded but not set off — the cash ledger is funded and the liability still stands'
            : 'No challan recorded against this period',
        dueOn: gstr3bDue(end, quarterly, company.stateCode),
        penalty: '18% a year, per day, on the cash component under s.50(1)',
        done: gstDischarged,
        href: '/tax/gst',
      })
    }

    push({
      id: 'gstr9',
      obligation: 'GSTR9',
      title: `File the GST annual return for FY ${fy.label}`,
      detail: 'GSTR-9, reconciling the year against what was filed',
      dueOn: gstr9Due(fyStartYear),
      href: '/tax/gst',
    })
  }

  /* ── profession tax ───────────────────────────────────────────────────────── */

  if (employees > 0) {
    for (const half of ['H1', 'H2'] as const) {
      push({
        id: `ptax-${half}`,
        obligation: 'PROFESSION_TAX',
        title: `Pay Kerala profession tax — ${half === 'H1' ? 'Apr to Sep' : 'Oct to Mar'}`,
        detail: 'Deducted in September and March, by slab',
        dueOn: professionTaxDue(half, fyStartYear),
        href: '/payroll/runs',
      })
    }
  }

  /* ── LUT, only if there is anything to export ─────────────────────────────── */

  const [exportCustomers, lut] = await Promise.all([
    prisma.customer.count({ where: { companyId: ctx.companyId, country: { not: 'IN' }, isActive: true } }),
    prisma.companyLut.findFirst({ where: { companyId: ctx.companyId, fyLabel: fy.label } }),
  ])
  if (exportCustomers > 0) {
    push({
      id: 'lut',
      obligation: 'LUT_RENEWAL',
      title: `File the LUT for FY ${fy.label}`,
      detail: lut
        ? `On file — ARN ${lut.arn}`
        : `${exportCustomers} overseas ${exportCustomers === 1 ? 'customer' : 'customers'} and no LUT. Export invoices are blocked.`,
      // 🔴 due BEFORE the year starts: an export raised zero-rated without a current LUT is
      // simply not zero-rated, and the IGST becomes payable
      dueOn: lutRenewalDue(fyStartYear),
      penalty: 'Without it the supply is taxable — IGST becomes payable on every export',
      done: !!lut,
      href: '/settings/lut',
    })
  }

  push({
    id: 'itr',
    obligation: 'ITR',
    title: `File the company income tax return for FY ${fy.label}`,
    detail: 'With the tax audit report, where one is required',
    dueOn: itrDue(fyStartYear),
    href: '/reports/pnl',
  })

  return out.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())
}

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (m: number) => MONTHS[m] ?? String(m)
// Indian grouping, like everywhere else — ₹68,888.88, never ₹68888.88
const fmt = (v: Decimal) => formatINR(v)

function quarterOf(d: Date): 1 | 2 | 3 | 4 {
  const m = d.getUTCMonth() + 1
  if (m >= 4 && m <= 6) return 1
  if (m >= 7 && m <= 9) return 2
  if (m >= 10 && m <= 12) return 3
  return 4
}


