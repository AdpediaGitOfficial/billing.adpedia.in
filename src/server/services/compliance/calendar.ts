import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { filedPeriods } from '@/server/services/tax/gst-filing'
import { filesGstr1And3b } from '@/server/services/tax/gst-registration'
import { isGstRegistered } from '@/server/services/invoicing/document-type'
import { paidPeriods } from '@/server/services/tax/gst-payment'
import { dischargedPeriods } from '@/server/services/tax/gst-setoff'
import { filedTdsQuarters, formForSectionCode } from '@/server/services/tax/tds-filing'
import { certificatesOutstanding } from '@/server/services/tax/tds-certificate'
import { periodFor } from '@/server/services/tax/periods'
import { currentFinancialYear } from '@/server/services/accounting/period'
import { advanceTaxPosition } from '@/server/services/tax/advance-tax'
import { itrPositionFor } from './itr'
import {
  tdsDepositDue, tdsReturnDue, form16aDue, form16Due,
  gstr1Due, gstr3bDue, gstr9Due, professionTaxDue, lutRenewalDue,
  agmDue, aoc4Due, mgt7Due, ROC_LATE_FEE_PER_DAY,
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
    select: { stateCode: true, gstFilingFrequency: true, gstin: true, gstRegistrationType: true },
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

  /**
   * 🔴 docs/82 §4 — was `if (company.gstin)`, and a GSTIN is not the question.
   *
   * An unregistered entity has no GSTIN, so the items happened not to appear — correct by
   * accident. A composition taxpayer HAS one and files CMP-08 and GSTR-4, so the calendar told
   * it to file a GSTR-1 on the 11th and a GSTR-3B it never files, both marked overdue for ever
   * because nothing could ever clear them. A calendar that nags about the wrong return is how
   * the right one gets missed (docs/43 §1).
   */
  if (filesGstr1And3b(company.gstRegistrationType)) {
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
  // 🔴 and only if the export is zero-rated at all: an unregistered supplier's overseas bill
  // is a bill of supply, which carries no IGST to be relieved of and needs no RFD-11
  if (exportCustomers > 0 && isGstRegistered(company.gstRegistrationType)) {
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

  /* ── advance tax, s.211 ───────────────────────────────────────────────────── */

  /**
   * 🔴 On the calendar whether or not an estimate exists — docs/71.
   *
   * The dates are statutory and do not wait for the CA. Leaving the instalments off until
   * somebody enters a liability means the one thing that would prompt them to go and get one
   * is the thing that is missing, and 15 June passes in silence.
   *
   * Where there is no estimate the item says so instead of showing a figure. Where there is,
   * the shortfall and the s.234C interest come with it — and an instalment inside the proviso
   * (12% by June, 36% by September) counts as DONE, because no interest is running on it even
   * though it is short.
   */
  const advance = await advanceTaxPosition(ctx, fy.id, now)
  for (const i of advance.instalments) {
    const short = i.shortfall.gt(0) && !i.withinSafeHarbour
    push({
      id: `advance-tax-${i.by}`,
      obligation: 'ADVANCE_TAX',
      title: `Advance tax — ${i.cumulativePct}% of FY ${fy.label} by this date`,
      detail: advance.estimate
        ? short
          /**
           * 🔴 "short" before the date has passed is not a shortfall, it is a plan.
           *
           * Nothing is owed until 15 December; calling ₹3,60,000 a shortfall in October is the
           * frightening-figure-that-means-nothing of docs/56 §2, and after three of those
           * nobody reads the screen.
           */
          ? i.passed
            ? `${formatINR(i.paid)} paid of ${formatINR(i.required)} required — ${formatINR(i.shortfall)} short`
            : `${formatINR(i.paid)} paid so far; ${formatINR(i.shortfall)} still to pay by then`
          : i.withinSafeHarbour
            ? `${formatINR(i.paid)} paid, short of ${formatINR(i.required)} but inside the s.234C proviso at ${i.safeHarbourPct}%`
            : `${formatINR(i.paid)} paid of ${formatINR(i.required)} required`
        : 'No estimate of this year’s tax has been recorded, so the amount cannot be computed — the date is statutory either way',
      dueOn: i.dueOn,
      // 🔴 the fixed months of s.234C, not a per-day or per-part-month accrual
      penalty: short
        ? `1% a month for ${i.interestMonths} month${i.interestMonths === 1 ? '' : 's'} under s.234C` +
          (i.passed ? ` — ${formatINR(i.interest)}` : ', if it is still short on the day')
        : undefined,
      // the figure is highlighted only once it is actually owed
      amount: advance.estimate && short && i.passed ? i.shortfall : undefined,
      href: '/tax/advance',
      done: Boolean(advance.estimate) && (i.shortfall.isZero() || i.withinSafeHarbour),
    })
  }

  /* ── company law: the AGM, then the two forms that run from it ────────────── */

  /**
   * 🔴 The forms key off the MEETING, not off its deadline — docs/72.
   *
   * s.137(1) gives thirty days from the AGM for AOC-4 and s.92(4) sixty for MGT-7. An AGM held
   * on 15 August makes AOC-4 due on 14 September, six weeks before the 30 October anybody
   * assuming a 30 September meeting would have written down.
   *
   * 🔴 And where no meeting has been held, the obligation is the MEETING. A company cannot
   * file AOC-4 before its AGM, so an overdue AOC-4 with no AGM behind it points at the wrong
   * form and sends somebody to the portal to do something they cannot do. The forms are shown
   * as waiting, with the latest date they could fall due, and the meeting carries the urgency.
   */
  /**
   * 🔴 The ROC obligations are about the year that has ENDED, not the year we are in.
   *
   * The AGM for FY 2026-27 is held in 2027; what is live in October 2026 is the AGM for FY
   * 2025-26, which was due on 30 September 2026. Keying these off `currentFinancialYear` would
   * show a date a year away and silently omit the one that is already five days late — the
   * same family of mistake as docs/49 §4's "the newest OPEN year is not the year you are in",
   * asked of a different question.
   */
  const reported = await prisma.financialYear.findFirst({
    where: { companyId: ctx.companyId, endsOn: { lt: now } },
    orderBy: { endsOn: 'desc' },
  })

  if (reported) {
    const agmLimit = agmDue(reported.endsOn)
    const held = reported.agmHeldOn

    push({
      id: 'agm',
      obligation: 'AGM',
      title: `Hold the annual general meeting for FY ${reported.label}`,
      detail: held
        ? `Held on ${held.toISOString().slice(0, 10)}${reported.agmSource ? ` · ${reported.agmSource}` : ''}`
        : 's.96 — within six months of the year end. A first AGM gets nine months, and no two may be more than fifteen apart, which can make the real date earlier than this.',
      dueOn: agmLimit,
      href: '/settings/company',
      done: Boolean(held),
    })

    const rocDays = (dueOn: Date) => Math.max(0, Math.ceil((now.getTime() - dueOn.getTime()) / DAY))
    for (const form of [
      { id: 'aoc4', obligation: 'AOC4' as const, name: 'AOC-4', what: 'the financial statements', section: 's.137(1)', days: 30, due: aoc4Due, filedOn: reported.aoc4FiledOn },
      { id: 'mgt7', obligation: 'MGT7' as const, name: 'MGT-7', what: 'the annual return', section: 's.92(4)', days: 60, due: mgt7Due, filedOn: reported.mgt7FiledOn },
    ]) {
      const dueOn = form.due(held ?? agmLimit)
      const late = held && !form.filedOn ? rocDays(dueOn) : 0
      push({
        id: form.id,
        obligation: form.obligation,
        title: `File ${form.name} for FY ${reported.label}`,
        detail: form.filedOn
          ? `Filed on ${form.filedOn.toISOString().slice(0, 10)} — ${form.section}`
          : held
          ? `${form.what} — ${form.section}, ${form.days} days from the meeting on ${held.toISOString().slice(0, 10)}`
          : `${form.what} — ${form.section}, ${form.days} days from the AGM. Record the meeting first; it cannot be filed before one is held.`,
        dueOn,
        // 🔴 ₹100 a day, per form, uncapped since 2018 — worth a number rather than "a penalty"
        penalty: late > 0
          ? `₹${ROC_LATE_FEE_PER_DAY} a day under s.403 — ${formatINR(String(late * ROC_LATE_FEE_PER_DAY))} so far`
          : `₹${ROC_LATE_FEE_PER_DAY} a day under s.403, with no upper limit`,
        href: '/settings/company',
        done: Boolean(form.filedOn),
        // without a meeting there is nothing to file, so it is not yet an obligation at all
        notApplicable: !held && !form.filedOn,
      })
    }
  }

  /* ── the two annual tax returns ───────────────────────────────────────────── */

  /**
   * 🔴 About the year that has ENDED, like the registrar's forms — docs/76, closing what
   * docs/72 §2 wrote down and left.
   *
   * Both were keyed off `currentFinancialYear`, so in October 2026 the calendar showed the ITR
   * for FY 2026-27 due on 31 October 2027 — and said nothing about FY 2025-26's, which was due
   * that same week. The item that was present was the one that did not matter.
   *
   * 🔴 And both need a fact that clears them, or they nag for ever once the date passes, which
   * is what docs/43 §1 says destroys a calendar. Neither portal is one this system talks to, so
   * the filing is recorded by hand beside the ROC dates.
   */
  if (reported) {
    if (filesGstr1And3b(company.gstRegistrationType)) {
      push({
        id: 'gstr9',
        obligation: 'GSTR9',
        title: `File the GST annual return for FY ${reported.label}`,
        detail: reported.gstr9FiledOn
          ? `Filed on ${reported.gstr9FiledOn.toISOString().slice(0, 10)}${reported.gstr9Arn ? ` · ARN ${reported.gstr9Arn}` : ''}`
          : 'GSTR-9, reconciling the year against what was filed',
        dueOn: gstr9Due(reported.startsOn.getUTCFullYear()),
        href: '/tax/gst',
        done: Boolean(reported.gstr9FiledOn),
      })
    }

    /**
     * 🔴 docs/82 §5d — s.139(1) has two dates, and this item showed one of them to everybody.
     *
     * `itrPosition` resolves which, from the constitution and the year's own turnover: a
     * company is clause (a) and files by 31 October; anybody else is clause (c) and files by
     * **31 July** unless an audit applies. Told October, docs/82's proprietorship would have
     * filed three months late, with s.234A interest, a s.234F fee and no loss carry-forward.
     */
    const itr = await itrPositionFor(ctx, reported)
    push({
      id: 'itr',
      obligation: 'ITR',
      title: itr.title,
      detail: reported.itrFiledOn
        ? `Filed on ${reported.itrFiledOn.toISOString().slice(0, 10)}${reported.itrAckNo ? ` · ack ${reported.itrAckNo}` : ''}`
        : `${itr.form} · ${itr.note}`,
      dueOn: itr.dueOn,
      href: '/settings/company',
      done: Boolean(reported.itrFiledOn),
    })

    // 🔴 and the report the return waits on, which is due a MONTH earlier — only where the
    // audit is certain, because an item nobody owes is the kind that gets the calendar ignored
    if (itr.reportDueOn && !reported.itrFiledOn) {
      push({
        id: 'tax-audit-report',
        obligation: 'ITR',
        title: `Tax audit report for FY ${reported.label}`,
        detail: 'Form 3CA/3CB with 3CD, signed by the auditor — s.44AB. The return cannot go '
          + 'without it, and it is the half that depends on somebody else\u2019s diary.',
        dueOn: itr.reportDueOn,
        href: '/settings/company',
        done: Boolean(reported.itrFiledOn),
      })
    }
  }

  /**
   * The CURRENT year's two, kept as scheduled items so the year ahead is visible. They cannot
   * be filed yet and are never overdue, because their dates are after the year has ended.
   */
  const itrCurrent = await itrPositionFor(ctx, fy, now)
  push({
    id: 'itr-current',
    obligation: 'ITR',
    title: itrCurrent.title,
    detail: `${itrCurrent.form}, not until the year has ended — shown so the date is on the calendar. ${itrCurrent.note}`,
    dueOn: itrCurrent.dueOn,
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


