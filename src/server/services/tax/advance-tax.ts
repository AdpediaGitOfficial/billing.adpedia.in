import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { oltasCin, validateChallanRefs } from './tds-challan'
import {
  ADVANCE_TAX_SCHEDULE, ADVANCE_TAX_INTEREST_PCT_PER_MONTH, advanceTaxDue,
} from '@/server/services/compliance/deadlines'

/**
 * The company's own advance tax — docs/71.
 *
 * 🔴 Everything here hangs off a number this system cannot derive. Taxable income is not book
 * profit: depreciation is computed differently, s.40 and s.43B disallow things the P&L has
 * already taken, and the rate depends on which regime was elected. So the liability is the
 * CA's estimate, recorded as such; what the books hold is profit before tax, and that is
 * context for the conversation rather than an answer.
 *
 * Until an estimate is entered, this module reports the DATES and says plainly that nothing
 * can be computed. A screen that filled in a plausible figure would be worse than an empty
 * one, because nobody re-checks a tax computation that looks reasonable.
 */

const ADVANCE_TAX_ACCOUNT = '1350'

export interface Instalment {
  by: 'JUN' | 'SEP' | 'DEC' | 'MAR'
  dueOn: Date
  cumulativePct: number
  safeHarbourPct: number
  /** what must have been paid by this date, cumulative */
  required: Decimal
  /** below this there is interest; at or above it there is none, even short of `required` */
  safeHarbour: Decimal
  /** actually paid on or before this date, cumulative */
  paid: Decimal
  shortfall: Decimal
  /** s.234C, computed only once the date has passed */
  interest: Decimal
  /** 🔴 true when the shortfall is forgiven by the proviso rather than absent */
  withinSafeHarbour: boolean
  /** fixed by s.234C — three months for the first three instalments, one for the last */
  interestMonths: number
  passed: boolean
}

export interface AdvanceTaxPosition {
  financialYearId: string
  fyLabel: string
  estimate: { amount: Decimal; source: string | null; note: string | null; at: Date } | null
  paid: Decimal
  instalments: Instalment[]
  interestSoFar: Decimal
  /** what the BOOKS say, which is not the taxable income — stated as context, never as tax */
  profitBeforeTax: Decimal | null
  notes: string[]
}

/* ── the CA's estimate ───────────────────────────────────────────────────────── */

export async function currentEstimate(companyId: string, financialYearId: string) {
  return prisma.companyTaxEstimate.findFirst({
    where: { companyId, financialYearId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Record an estimate, superseding whatever stood before it.
 *
 * 🔴 Superseded, never updated. An instalment paid against an earlier estimate was correct
 * when it was paid, and s.234C is charged on the liability as finally determined — so the
 * history of what was believed, and when, is the only thing that explains a figure to
 * somebody reading it later.
 */
export async function setTaxEstimate(ctx: RequestContext, input: {
  financialYearId: string
  estimatedAnnualTax: string
  source?: string
  note?: string
}) {
  assertCan(ctx.role, 'tax', 'write')
  const amount = round2(new Decimal(input.estimatedAnnualTax || '0'))
  if (amount.lt(0)) throw new AppError('An estimate cannot be negative')
  const source = input.source?.trim()
  if (!source) {
    throw new AppError('Say where the estimate came from — it is a number nobody can derive from the books')
  }

  const fy = await prisma.financialYear.findFirst({
    where: { id: input.financialYearId, companyId: ctx.companyId },
  })
  if (!fy) throw new NotFound('Financial year not found')

  return prisma.$transaction(async (tx) => {
    const previous = await tx.companyTaxEstimate.findFirst({
      where: { companyId: ctx.companyId, financialYearId: fy.id, supersededAt: null },
    })
    if (previous) {
      await tx.companyTaxEstimate.update({ where: { id: previous.id }, data: { supersededAt: new Date() } })
    }
    const created = await tx.companyTaxEstimate.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id,
        estimatedAnnualTax: amount.toFixed(2),
        source, note: input.note?.trim() || null,
      },
    })
    await audit(ctx, {
      entity: 'CompanyTaxEstimate', entityId: created.id, action: previous ? 'UPDATE' : 'CREATE',
      before: previous ? { estimate: previous.estimatedAnnualTax.toString() } : undefined,
      after: { estimate: amount.toFixed(2), source, fy: fy.label },
    }, tx)
    return created
  })
}

/* ── the instalments actually paid ───────────────────────────────────────────── */

export async function recordAdvanceTax(ctx: RequestContext, input: {
  paidOn: string
  amount: string
  bsrCode: string
  challanSerial: string
  bankAccountId?: string
  note?: string
}) {
  assertCan(ctx.role, 'tax', 'write')
  validateChallanRefs(input.bsrCode, input.challanSerial)

  const paidOn = new Date(input.paidOn)
  if (Number.isNaN(paidOn.getTime())) throw new AppError('That is not a valid date')
  const amount = round2(new Decimal(input.amount || '0'))
  if (amount.lte(0)) throw new AppError('An advance tax payment needs an amount')

  const fy = await assertPostable(ctx.companyId, paidOn)

  return prisma.$transaction(async (tx) => {
    const bank = input.bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({
          where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true },
        })
      : await tx.companyBankAccount.findFirstOrThrow({
          where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true },
        })
    if (!bank.ledgerAccount) throw new AppError(`${bank.label} is not mapped to a ledger account`)

    const payment = await tx.advanceTaxPayment.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id,
        paidOn, amount: amount.toFixed(2),
        bsrCode: input.bsrCode, challanSerial: input.challanSerial,
        // docs/56 §3 — constructed, and a guess until a statement says the same thing
        cin: oltasCin(input.bsrCode, paidOn, input.challanSerial),
        bankAccountId: bank.id, note: input.note?.trim() || null,
      },
    })

    /**
     * 🔴 An ASSET, not an expense. This is money on account against a liability the return has
     * not yet settled. Booking it to the P&L understates the year's profit by whatever has
     * been paid, and then double-counts the moment the final tax is provided for.
     */
    await postJournal(ctx, {
      date: paidOn,
      narration: `Advance tax ${fy.label} — challan ${input.bsrCode}/${input.challanSerial}`,
      sourceType: 'ADVANCE_TAX', sourceId: payment.id,
      postings: [
        { accountCode: ADVANCE_TAX_ACCOUNT, debit: amount },
        { accountCode: bank.ledgerAccount.code, credit: amount },
      ],
    }, tx)

    await audit(ctx, {
      entity: 'AdvanceTaxPayment', entityId: payment.id, action: 'CREATE',
      after: { amount: amount.toFixed(2), paidOn: input.paidOn, fy: fy.label, cin: payment.cin },
    }, tx)

    return payment
  })
}

export async function listAdvanceTax(ctx: RequestContext, financialYearId: string) {
  assertCan(ctx.role, 'tax', 'read')
  return prisma.advanceTaxPayment.findMany({
    where: { companyId: ctx.companyId, financialYearId },
    orderBy: { paidOn: 'asc' },
  })
}

/* ── the position ────────────────────────────────────────────────────────────── */

/**
 * Where the year stands against s.211 and s.234C.
 *
 * 🔴 Every figure that depends on the liability is absent, not zero, when no estimate has been
 * recorded. `required`, `shortfall` and `interest` would all compute to 0.00 against a
 * liability of zero, and a screen reading "shortfall ₹0.00" is a statement that nothing is
 * owed — which is the opposite of what is true, which is that nobody has worked it out.
 */
export async function advanceTaxPosition(
  ctx: RequestContext,
  financialYearId: string,
  now = new Date(),
): Promise<AdvanceTaxPosition> {
  assertCan(ctx.role, 'tax', 'read')

  const fy = await prisma.financialYear.findFirst({ where: { id: financialYearId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')
  const fyStartYear = fy.startsOn.getUTCFullYear()

  const [estimate, payments] = await Promise.all([
    currentEstimate(ctx.companyId, fy.id),
    prisma.advanceTaxPayment.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id, cancelledAt: null },
      orderBy: { paidOn: 'asc' },
    }),
  ])

  const liability = estimate ? new Decimal(estimate.estimatedAnnualTax.toString()) : null
  const paid = payments.reduce((a, p) => a.plus(p.amount.toString()), ZERO as Decimal)
  const notes: string[] = []

  const instalments: Instalment[] = ADVANCE_TAX_SCHEDULE.map((step) => {
    const dueOn = advanceTaxDue(step.by, fyStartYear)
    const passed = now > dueOn
    /**
     * 🔴 Paid ON OR BEFORE the due date, not "paid in the quarter". A payment made on 20 June
     * does not count towards the June instalment at all — it counts towards September's, and
     * June's interest is charged in full regardless.
     */
    const paidBy = payments
      .filter((p) => p.paidOn <= dueOn)
      .reduce((a, p) => a.plus(p.amount.toString()), ZERO as Decimal)

    const required = liability ? round2(liability.mul(step.cumulativePct).div(100)) : ZERO
    const safeHarbour = liability ? round2(liability.mul(step.safeHarbourPct).div(100)) : ZERO
    const shortfall = liability ? Decimal.max(required.minus(paidBy), ZERO) : ZERO
    const withinSafeHarbour = Boolean(liability) && paidBy.gte(safeHarbour) && shortfall.gt(0)

    const interest = liability && passed && !withinSafeHarbour
      ? round2(shortfall.mul(ADVANCE_TAX_INTEREST_PCT_PER_MONTH).div(100).mul(step.interestMonths))
      : ZERO

    return {
      by: step.by, dueOn,
      cumulativePct: step.cumulativePct, safeHarbourPct: step.safeHarbourPct,
      required, safeHarbour, paid: paidBy, shortfall, interest, withinSafeHarbour,
      interestMonths: step.interestMonths, passed,
    }
  })

  if (!estimate) {
    notes.push(
      'No estimate of this year’s tax has been recorded, so nothing below can be computed — only the dates. ' +
      'The figure is the CA’s: taxable income is not book profit, and the rate depends on the regime elected.',
    )
  } else {
    notes.push(
      `Computed against ${formatINR(liability!)}, estimated ${estimate.createdAt.toISOString().slice(0, 10)}` +
      `${estimate.source ? ` by ${estimate.source}` : ''}. s.234C is finally charged on the tax due on the ` +
      'RETURNED income, so this moves when the return is filed.',
    )
    if (instalments.some((i) => i.withinSafeHarbour)) {
      notes.push(
        'One or more instalments are short of the percentage but within the proviso to s.234C(1) — 12% by 15 June, ' +
        '36% by 15 September — so no interest is charged on them. The shortfall still has to be made up.',
      )
    }
  }

  /**
   * What the books say, as context. 🔴 Explicitly NOT the taxable income, and labelled that way
   * everywhere it is shown: depreciation, s.40 and s.43B all move it, and quoting it as the
   * base of a tax computation is how a wrong number acquires authority.
   */
  const profit = await profitBeforeTax(ctx.companyId, fy.startsOn, fy.endsOn)

  return {
    financialYearId: fy.id,
    fyLabel: fy.label,
    estimate: estimate
      ? {
          amount: liability!,
          source: estimate.source,
          note: estimate.note,
          at: estimate.createdAt,
        }
      : null,
    paid,
    instalments,
    interestSoFar: instalments.reduce((a, i) => a.plus(i.interest), ZERO as Decimal),
    profitBeforeTax: profit,
    notes,
  }
}

/** Income less expenses from the journal, which is the books' own profit and nothing more. */
async function profitBeforeTax(companyId: string, from: Date, to: Date): Promise<Decimal | null> {
  const lines = await prisma.journalLine.findMany({
    where: {
      journalEntry: { companyId, date: { gte: from, lte: to } },
      account: { type: { in: ['INCOME', 'EXPENSE'] } },
    },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  })
  if (lines.length === 0) return null

  return lines.reduce((a, l) => {
    const d = new Decimal(l.debit.toString()), c = new Decimal(l.credit.toString())
    // income is a credit balance, expense a debit one; profit is income less expense
    return l.account.type === 'INCOME' ? a.plus(c).minus(d) : a.minus(d).plus(c)
  }, ZERO as Decimal)
}
