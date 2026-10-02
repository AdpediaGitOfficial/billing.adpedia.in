import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable, currentFinancialYear } from '@/server/services/accounting/period'
import { GST_ACCOUNTS, CASH_LEDGER_ACCOUNTS, gstPosition } from './gst-ledger'
import { gstInterest } from './gst-payment'
import { creditLedgerBalance, cashLedgerBalance } from './gst-electronic-ledgers'
import {
  planSetOff, type LiabilityHeads, type CreditHeads, type CashHeads, type SetOffPlan,
} from './gst-setoff-engine'
import { periodsInFy } from './periods'
import { gstr3bDue } from '@/server/services/compliance/deadlines'

export { planSetOff }
export type {
  LiabilityHeads, CreditHeads, CashHeads, SetOffPlan, CreditUtilisation, SetOffInput,
} from './gst-setoff-engine'

/**
 * The set-off — GSTR-3B table 6.1, and the step that actually discharges the tax.
 *
 * 🔴 Paying GST is two events, not one, and until this module the system only modelled
 * one of them. A challan puts money in the **electronic cash ledger**; the liability is
 * discharged later, when the return is offset and the portal debits that ledger together
 * with the **electronic credit ledger**. Collapsing the two hid three real things:
 *
 *   1. money deposited and not yet offset is an ASSET, not a settled liability
 *   2. 🔴 credit is utilised HEAD-WISE, and CGST credit may never pay SGST — netting all
 *      ITC against all output tax understates the cash actually required
 *   3. 🔴 interest runs to the date the cash ledger is DEBITED (rule 88B), not to the date
 *      it was funded — money sitting in the cash ledger does not stop the clock
 */

/* ────────────────────────────────────────────────────────────────────────────
   The service — what the period actually owes, and recording the discharge.
   ──────────────────────────────────────────────────────────────────────────── */

export interface SetOffPreview {
  periodLabel: string
  setOffOn: Date
  dueOn: Date
  liability: LiabilityHeads & { total: Decimal }
  credit: CreditHeads
  cash: CashHeads
  plan: SetOffPlan
  /** 🔴 interest to the date of DEBIT, not the date the cash ledger was funded */
  interestToDate: { days: number; interest: Decimal; note: string }
  alreadyDischarged: { igst: Decimal; cgst: Decimal; sgst: Decimal; rcm: Decimal; interest: Decimal; lateFee: Decimal }
  warnings: string[]
}

async function periodOf(companyId: string, periodLabel: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId }, select: { gstFilingFrequency: true, stateCode: true },
  })
  const fy = await currentFinancialYear(companyId)
  if (!fy) throw new NotFound('No open financial year')
  const period = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
    .find((p) => p.label === periodLabel)
  if (!period) throw new AppError(`${periodLabel} is not a filing period for FY ${fy.label}`)
  return { company, fy, period }
}

/** What earlier set-offs for this period already cleared, so a second one cannot double-discharge. */
export async function alreadyDischarged(companyId: string, periodLabel: string) {
  const rows = await prisma.gstSetOff.aggregate({
    where: { companyId, periodLabel, cancelledAt: null },
    _sum: { igst: true, cgst: true, sgst: true, rcm: true, interest: true, lateFee: true },
  })
  const d = (v: unknown) => new Decimal(v?.toString() ?? '0')
  return {
    igst: d(rows._sum.igst), cgst: d(rows._sum.cgst), sgst: d(rows._sum.sgst),
    rcm: d(rows._sum.rcm), interest: d(rows._sum.interest), lateFee: d(rows._sum.lateFee),
  }
}

/**
 * What this period still owes, and how it would be discharged today.
 *
 * The liability is read from the LEDGER, like every other figure in the system, and reduced
 * by whatever earlier set-offs for the period already cleared. Interest and late fee come
 * from the challans recorded against the period — the portal's own computation governs, so
 * the figure deposited is the figure settled.
 */
export async function previewSetOff(ctx: RequestContext, periodLabel: string, on: Date): Promise<SetOffPreview> {
  assertCan(ctx.role, 'tax', 'read')
  const { company, period } = await periodOf(ctx.companyId, periodLabel)

  const [pos, done, challans, credit, cash] = await Promise.all([
    gstPosition(ctx.companyId, period.from, period.to),
    alreadyDischarged(ctx.companyId, periodLabel),
    prisma.gstChallan.aggregate({
      where: { companyId: ctx.companyId, periodLabel, cin: { not: null } },
      _sum: { interest: true, lateFee: true },
    }),
    creditLedgerBalance(ctx.companyId, on),
    cashLedgerBalance(ctx.companyId, on),
  ])

  const left = (gross: Decimal, cleared: Decimal) => Decimal.max(gross.minus(cleared), ZERO)
  const liability: LiabilityHeads = {
    igst: left(pos.output.igst, done.igst),
    cgst: left(pos.output.cgst, done.cgst),
    sgst: left(pos.output.sgst, done.sgst),
    rcm: left(pos.rcm.payable, done.rcm),
    interest: left(new Decimal(challans._sum.interest?.toString() ?? '0'), done.interest),
    lateFee: left(new Decimal(challans._sum.lateFee?.toString() ?? '0'), done.lateFee),
  }

  const plan = planSetOff({ liability, credit, cash })
  const dueOn = gstr3bDue(period.to, company.gstFilingFrequency === 'QUARTERLY', company.stateCode)

  // 🔴 Rule 88B(1): interest runs from the due date to the date the electronic cash ledger
  // is DEBITED — which is this moment, not the moment a challan funded it. Money parked in
  // the cash ledger has not paid anything.
  const cashComponent = plan.cash.igst.minus(plan.cashToRcm).plus(plan.cash.cgst).plus(plan.cash.sgst)
  const interestToDate = gstInterest(cashComponent, dueOn, on)

  const warnings: string[] = []
  if (plan.shortfall.total.gt(0)) {
    warnings.push(
      `${formatINR(plan.shortfall.total)} short in the cash ledger. Record the challan first — a set-off cannot ` +
      'create a negative balance, any more than the portal would let it.',
    )
  }
  if (interestToDate.interest.gt(liability.interest.plus(liability.lateFee))) {
    warnings.push(
      `Interest to today works out at ${formatINR(interestToDate.interest)} on the cash component, and only ` +
      `${formatINR(liability.interest.plus(liability.lateFee))} of interest and fee has been deposited. Under rule 88B(1) ` +
      'interest runs until the cash ledger is debited — funding it earlier did not stop the clock.',
    )
  }
  if (liability.igst.plus(liability.cgst).plus(liability.sgst).plus(liability.rcm).isZero()) {
    warnings.push('Nothing left to discharge for this period — the output tax is already cleared.')
  }

  return {
    periodLabel, setOffOn: on, dueOn,
    liability: {
      ...liability,
      total: liability.igst.plus(liability.cgst).plus(liability.sgst)
        .plus(liability.rcm).plus(liability.interest).plus(liability.lateFee),
    },
    credit, cash, plan, interestToDate,
    alreadyDischarged: done,
    warnings,
  }
}

export interface RecordSetOffInput {
  periodLabel: string
  setOffOn: string
}

/**
 * Record the set-off and post it.
 *
 * Debits the output liabilities being discharged and the interest to expense; credits the
 * credit ledger accounts actually utilised and the cash ledger accounts actually debited.
 * This is the entry that was previously folded into the payment, and folding it in was what
 * made a funded-but-unfiled period look settled.
 */
export async function recordSetOff(ctx: RequestContext, input: RecordSetOffInput) {
  assertCan(ctx.role, 'tax', 'write')

  const on = new Date(input.setOffOn)
  if (Number.isNaN(on.getTime())) throw new AppError('That is not a valid set-off date')
  const fy = await assertPostable(ctx.companyId, on)

  const p = await previewSetOff(ctx, input.periodLabel, on)
  const { plan } = p

  if (plan.shortfall.total.gt(0)) {
    throw new AppError(
      `The cash ledger is ${formatINR(plan.shortfall.total)} short for ${input.periodLabel}. ` +
      plan.notes.filter((n) => n.startsWith('A challan is needed') || n.includes('PMT-09')).join(' ') +
      ' A set-off cannot overdraw the cash ledger.',
    )
  }
  if (plan.discharged.total.lte(0)) {
    throw new AppError(
      `Nothing to set off for ${input.periodLabel} — either the liability is already discharged, or the ` +
      'cash and credit ledgers are both empty.',
    )
  }

  // IGST credit lives in two accounts — ordinary input IGST and the IGST credit arising on
  // reverse charge. They are the same credit to the portal, so the ordinary one is used
  // first and the RCM one takes the remainder.
  const igstCreditUsed = plan.credit.igstToIgst.plus(plan.credit.igstToCgst).plus(plan.credit.igstToSgst)
  const plainIgstAvailable = await accountNaturalBalance(ctx.companyId, GST_ACCOUNTS.inputIgst, on)
  const fromPlainIgst = Decimal.min(igstCreditUsed, Decimal.max(plainIgstAvailable, ZERO))
  const fromRcmItc = igstCreditUsed.minus(fromPlainIgst)

  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.gstSetOff.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, periodLabel: input.periodLabel, setOffOn: on,
        igst: plan.discharged.igst.toFixed(2),
        cgst: plan.discharged.cgst.toFixed(2),
        sgst: plan.discharged.sgst.toFixed(2),
        rcm: plan.discharged.rcm.toFixed(2),
        interest: plan.discharged.interest.toFixed(2),
        lateFee: plan.discharged.lateFee.toFixed(2),
        creditIgstToIgst: plan.credit.igstToIgst.toFixed(2),
        creditIgstToCgst: plan.credit.igstToCgst.toFixed(2),
        creditIgstToSgst: plan.credit.igstToSgst.toFixed(2),
        creditCgstToCgst: plan.credit.cgstToCgst.toFixed(2),
        creditCgstToIgst: plan.credit.cgstToIgst.toFixed(2),
        creditSgstToSgst: plan.credit.sgstToSgst.toFixed(2),
        creditSgstToIgst: plan.credit.sgstToIgst.toFixed(2),
        cashIgst: plan.cash.igst.toFixed(2),
        cashCgst: plan.cash.cgst.toFixed(2),
        cashSgst: plan.cash.sgst.toFixed(2),
        cashOther: plan.cash.other.toFixed(2),
        creditUsed: plan.credit.total.toFixed(2),
        cashUsed: plan.cash.total.toFixed(2),
      },
    })

    const creditCgstUsed = plan.credit.cgstToCgst.plus(plan.credit.cgstToIgst)
    const creditSgstUsed = plan.credit.sgstToSgst.plus(plan.credit.sgstToIgst)
    const interestAndFee = plan.discharged.interest.plus(plan.discharged.lateFee)

    await postJournal(ctx, {
      date: on,
      narration: `GST set-off for ${input.periodLabel} — ${plan.credit.total.toFixed(2)} by credit, ${plan.cash.total.toFixed(2)} in cash`,
      sourceType: 'GST_SET_OFF', sourceId: saved.id,
      postings: [
        // liabilities discharged
        ...(plan.discharged.cgst.gt(0) ? [{ accountCode: GST_ACCOUNTS.outputCgst, debit: plan.discharged.cgst }] : []),
        ...(plan.discharged.sgst.gt(0) ? [{ accountCode: GST_ACCOUNTS.outputSgst, debit: plan.discharged.sgst }] : []),
        ...(plan.discharged.igst.gt(0) ? [{ accountCode: GST_ACCOUNTS.outputIgst, debit: plan.discharged.igst }] : []),
        ...(plan.discharged.rcm.gt(0) ? [{ accountCode: GST_ACCOUNTS.rcmPayable, debit: plan.discharged.rcm }] : []),
        // interest and late fee are a COST — nobody can claim them, and leaving them in a
        // tax account would overstate the liability and never clear
        ...(interestAndFee.gt(0)
          ? [{ accountCode: '5600', debit: interestAndFee, narration: 'GST interest and late fee' }]
          : []),
        // credit ledger utilised
        ...(fromPlainIgst.gt(0) ? [{ accountCode: GST_ACCOUNTS.inputIgst, credit: fromPlainIgst }] : []),
        ...(fromRcmItc.gt(0) ? [{ accountCode: GST_ACCOUNTS.rcmItc, credit: fromRcmItc }] : []),
        ...(creditCgstUsed.gt(0) ? [{ accountCode: GST_ACCOUNTS.inputCgst, credit: creditCgstUsed }] : []),
        ...(creditSgstUsed.gt(0) ? [{ accountCode: GST_ACCOUNTS.inputSgst, credit: creditSgstUsed }] : []),
        // cash ledger debited
        ...(plan.cash.igst.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.igst, credit: plan.cash.igst }] : []),
        ...(plan.cash.cgst.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.cgst, credit: plan.cash.cgst }] : []),
        ...(plan.cash.sgst.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.sgst, credit: plan.cash.sgst }] : []),
        ...(plan.cash.other.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.other, credit: plan.cash.other }] : []),
      ],
    }, tx)

    return saved
  })

  await audit(ctx, {
    entity: 'GstSetOff', entityId: row.id, action: 'POST',
    after: {
      period: input.periodLabel,
      byCredit: plan.credit.total.toFixed(2),
      inCash: plan.cash.total.toFixed(2),
    },
  })
  return row
}

/** Net balance on one account as at a date, in its natural direction. */
async function accountNaturalBalance(companyId: string, code: string, on: Date): Promise<Decimal> {
  const agg = await prisma.journalLine.aggregate({
    where: { account: { companyId, code }, journalEntry: { companyId, date: { lte: on } } },
    _sum: { debit: true, credit: true },
  })
  return round2(
    new Decimal(agg._sum.debit?.toString() ?? '0').minus(agg._sum.credit?.toString() ?? '0'),
  )
}

export async function listSetOffs(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  return prisma.gstSetOff.findMany({
    where: { companyId: ctx.companyId }, orderBy: { setOffOn: 'desc' },
  })
}

/**
 * Which periods are actually discharged — the calendar asks.
 *
 * 🔴 Not the same question as which periods have a challan. A funded cash ledger that has
 * never been debited has settled nothing, and under rule 88B(1) the interest is still running.
 */
export async function dischargedPeriods(companyId: string): Promise<Set<string>> {
  const rows = await prisma.gstSetOff.findMany({
    where: { companyId, cancelledAt: null }, select: { periodLabel: true },
  })
  return new Set(rows.map((r) => r.periodLabel))
}
