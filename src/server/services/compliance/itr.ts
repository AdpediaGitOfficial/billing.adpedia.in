import type { Constitution } from '@prisma/client'
import { prisma } from '@/server/db'
import { Decimal, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { profitAndLoss } from '@/server/services/reports/statements'
import { itrDue, taxAuditReportDue } from './deadlines'

/**
 * Which income tax return, on which of s.139(1)'s two dates — docs/82 §5d.
 *
 * 🔴 The calendar said *"File the company income tax return"* on **31 October** for every
 * entity, because when it was written there was one entity and it was a company. For
 * docs/82's proprietorship both halves were wrong: it files ITR-3 in the proprietor's own name,
 * and unless a s.44AB audit applies its deadline is **31 July** — three months earlier than
 * the date it was being shown.
 *
 * Pure on purpose. The turnover comes from the P&L, so the decision can be tested without a
 * database and the figure cannot disagree with the statement it came from.
 */

/** s.44AB(a) — business turnover above this needs an audit… */
export const AUDIT_TURNOVER_LIMIT = new Decimal('10000000')

/**
 * 🔴 …unless cash receipts AND cash payments are each 5% or less, which raises it to ₹10
 * crore. The cash test is a fact about every receipt and payment in the year, including ones
 * this system never sees, so it is NOT estimated here: between the two limits the answer is
 * "ask", and the earlier date is shown until somebody does.
 */
export const AUDIT_TURNOVER_LIMIT_LOW_CASH = new Decimal('100000000')

export interface ItrPosition {
  /** 🔴 true only where no unknown fact could change it */
  audited: boolean
  dueOn: Date
  /** the audit report's own date, where an audit is certain */
  reportDueOn: Date | null
  title: string
  /** ITR-3, ITR-5, ITR-6 */
  form: string
  /** what decided the date, and what would move it */
  note: string
}

interface Args {
  constitution: Constitution
  fyStartYear: number
  fyLabel: string
  /** revenue for the year from the P&L — not other income, which is not turnover */
  turnover: Decimal
}

const COMPANY: Constitution[] = ['PRIVATE_LIMITED', 'PUBLIC_LIMITED']
const FIRM: Constitution[] = ['PARTNERSHIP', 'LLP']

export function itrPosition({ constitution, fyStartYear, fyLabel, turnover }: Args): ItrPosition {
  if (COMPANY.includes(constitution)) {
    return {
      audited: true,
      dueOn: itrDue(fyStartYear, true),
      reportDueOn: taxAuditReportDue(fyStartYear),
      title: `File the company income tax return for FY ${fyLabel}`,
      form: 'ITR-6',
      // 🔴 a company is clause (a) by being a company — the audit limits are irrelevant to it
      note: 'A company files by 31 October under s.139(1)(a) whatever its turnover, with the '
        + 'tax audit report a month before it.',
    }
  }

  const firm = FIRM.includes(constitution)
  const whose = firm ? 'the firm’s' : 'the proprietor’s'
  const form = firm ? 'ITR-5' : 'ITR-3'

  /**
   * 🔴 Above ₹10 crore the audit applies whichever way the cash test falls, so the later date
   * is certain. Below it, it depends on a fact nobody here has — so the earlier date stands.
   */
  const certainlyAudited = turnover.gt(AUDIT_TURNOVER_LIMIT_LOW_CASH)

  if (certainlyAudited) {
    return {
      audited: true,
      dueOn: itrDue(fyStartYear, true),
      reportDueOn: taxAuditReportDue(fyStartYear),
      title: `File ${whose} income tax return for FY ${fyLabel}`,
      form,
      note: `Turnover of ${formatINR(turnover)} is past every s.44AB limit, so the accounts must `
        + 'be audited and s.139(1)(a) gives 31 October — with Form 3CB-3CD a month before it.',
    }
  }

  const over = turnover.gt(AUDIT_TURNOVER_LIMIT)
  return {
    audited: false,
    dueOn: itrDue(fyStartYear, false),
    reportDueOn: null,
    title: `File ${whose} income tax return for FY ${fyLabel}`,
    form,
    note: over
      ? `Turnover of ${formatINR(turnover)} is past the ₹1 crore in s.44AB(a), so an audit `
        + 'probably applies — and then the date moves to 31 October with the report due 30 '
        + 'September. It only does not if cash receipts AND cash payments were each 5% or less, '
        + 'which raises the limit to ₹10 crore and is not something these books can settle. '
        + 'Until the CA says which, the earlier date stands: being early costs nothing and '
        + 'being late costs s.234A interest, a s.234F fee and the loss carry-forward.'
      : `31 July under s.139(1)(c) — turnover of ${formatINR(turnover)} is inside the ₹1 crore `
        + 'in s.44AB(a), so no audit is required and the October date does not apply. It would '
        + 'move to 31 October if an audit became necessary, including the s.44AD(4) case of '
        + 'declaring under 8% of turnover as income.',
  }
}

/**
 * The same decision, with the turnover read from the books.
 *
 * 🔴 Turnover is `revenue.total` from the P&L — the 40xx accounts — and deliberately not
 * `totalIncome`. s.44AB(a) says "sales, turnover or gross receipts in BUSINESS": interest on a
 * deposit and a forex gain are income and are not turnover, and counting them would push an
 * entity over a limit it has not reached.
 */
export async function itrPositionFor(
  ctx: RequestContext,
  fy: { label: string; startsOn: Date; endsOn: Date },
  asOf?: Date,
): Promise<ItrPosition> {
  const to = asOf && asOf < fy.endsOn ? asOf : fy.endsOn
  const pnl = await profitAndLoss(ctx, { from: fy.startsOn, to })
  return itrPosition({
    constitution: (await prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId }, select: { constitution: true },
    })).constitution,
    fyStartYear: fy.startsOn.getUTCFullYear(),
    fyLabel: fy.label,
    turnover: pnl.revenue.total,
  })
}
