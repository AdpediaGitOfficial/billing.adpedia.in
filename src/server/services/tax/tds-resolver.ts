import { prisma } from '@/server/db'
import type { Tx } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import { NotFound } from '@/server/errors'
import { isCompanyOrFirm, isValidPanFormat } from './pan'

export interface TdsDecision {
  /** false when nothing is deducted on this bill */
  applies: boolean
  sectionCode: string | null
  ratePct: Decimal
  /** the amount the rate is applied to — usually this bill, but the whole year on a crossing */
  applyOn: Decimal
  tdsAmount: Decimal
  reason: string
  /** shown as a blocking prompt on the bill form */
  warning?: string
  returnForm: string | null
  cumulativeBefore: Decimal
  cumulativeAfter: Decimal
}

export interface DeducteeFacts {
  pan: string | null
  panVerified: boolean
  lowerDeductionRate: Decimal | null
  lowerDeductionValidTo: Date | null
  lowerDeductionCap: Decimal | null
  lowerDeductionCertNo: string | null
}

/** The effective-dated rate row for a section as it stood on a given date. */
export async function rateAsOf(sectionCode: string, onDate: Date, tx: Tx = prisma) {
  const row = await tx.tdsSectionRate.findFirst({
    where: {
      code: sectionCode,
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (!row) throw new NotFound(`No TDS rate on file for section ${sectionCode} as at ${onDate.toISOString().slice(0, 10)}`)
  return row
}

/**
 * What has already been paid to this vendor under this section, this financial year.
 *
 * 🔴 Counts EVERY bill carrying the section, including those where nothing was
 * deducted because the vendor was still under the limit. A threshold is measured on
 * total payments, not on taxed payments — filtering to bills with TDS would mean the
 * limit never appears to be crossed.
 */
export async function cumulativeThisFy(
  companyId: string, vendorId: string, sectionCode: string, financialYearId: string, excludeBillId?: string, tx: Tx = prisma,
): Promise<Decimal> {
  const rows = await tx.vendorBill.aggregate({
    where: {
      companyId, vendorId, financialYearId,
      tdsSection: sectionCode,
      status: { not: 'CANCELLED' },
      ...(excludeBillId ? { id: { not: excludeBillId } } : {}),
    },
    _sum: { taxableValue: true },
  })
  return new Decimal(rows._sum.taxableValue?.toString() ?? 0)
}

/**
 * docs/12 §4.1 — the five cases, in order.
 *
 * Step 4 is the one everybody gets wrong: when a vendor's cumulative payments cross the
 * annual threshold on a given bill, TDS falls due on the WHOLE cumulative amount, not on
 * the excess. Praveen C D is the live case (docs/04 §8).
 */
export async function resolveTds(args: {
  sectionCode: string | null
  onDate: Date
  /** taxable value of THIS bill, excluding GST — CBDT Circular 23/2017 */
  thisBillBase: Decimal
  deductee: DeducteeFacts
  cumulativeBefore: Decimal
  tx?: Tx
}): Promise<TdsDecision> {
  const { sectionCode, onDate, thisBillBase, deductee, cumulativeBefore, tx = prisma } = args

  const none = (reason: string): TdsDecision => ({
    applies: false, sectionCode, ratePct: ZERO, applyOn: ZERO, tdsAmount: ZERO, reason,
    returnForm: null, cumulativeBefore, cumulativeAfter: cumulativeBefore.plus(thisBillBase),
  })

  if (!sectionCode) return none('No TDS section set for this vendor')

  const rate = await rateAsOf(sectionCode, onDate, tx)
  const cumulativeAfter = cumulativeBefore.plus(thisBillBase)
  const build = (ratePct: Decimal, applyOn: Decimal, reason: string, warning?: string): TdsDecision => ({
    applies: ratePct.gt(0) && applyOn.gt(0),
    sectionCode, ratePct, applyOn,
    tdsAmount: round2(applyOn.mul(ratePct).div(100)),
    reason, warning, returnForm: rate.returnForm,
    cumulativeBefore, cumulativeAfter,
  })

  // 1 ── no verified PAN → s.206AA, flat higher rate, no threshold relief
  if (!isValidPanFormat(deductee.pan) || !deductee.panVerified) {
    return build(
      new Decimal(rate.rateNoPan.toString()), thisBillBase,
      `No verified PAN — s.206AA applies`,
      `Section 206AA: without a verified PAN, TDS is ${rate.rateNoPan}% rather than the normal rate, and the annual threshold gives no relief. Collect the PAN before paying.`,
    )
  }

  // 2 ── s.197 lower-deduction certificate, still valid and within its cap
  if (deductee.lowerDeductionRate && deductee.lowerDeductionValidTo && deductee.lowerDeductionValidTo >= onDate) {
    const cap = deductee.lowerDeductionCap
    if (!cap || cumulativeBefore.lt(cap)) {
      return build(
        deductee.lowerDeductionRate, thisBillBase,
        `Lower deduction certificate u/s 197${deductee.lowerDeductionCertNo ? ` (${deductee.lowerDeductionCertNo})` : ''}`,
        cap && cumulativeAfter.gt(cap)
          ? `This bill takes the vendor past the certificate cap of ${formatINR(cap)}. The excess is deductible at the normal rate — check the split with your CA.`
          : undefined,
      )
    }
  }

  const normalRate = new Decimal(
    (isCompanyOrFirm(deductee.pan) ? rate.rateCompany : rate.rateIndividualHuf).toString(),
  )
  const single = rate.thresholdSingle ? new Decimal(rate.thresholdSingle.toString()) : null
  const annual = rate.thresholdAnnual ? new Decimal(rate.thresholdAnnual.toString()) : null

  const overSingle = single ? thisBillBase.gt(single) : false
  const overAnnual = annual ? cumulativeAfter.gt(annual) : false

  // 3 ── under both thresholds → nothing to deduct yet
  if (!overSingle && !overAnnual) {
    const headroom = annual ? annual.minus(cumulativeAfter) : null
    return {
      ...none(
        `Below threshold — ${formatINR(cumulativeAfter)} paid this year against a limit of ${annual ? formatINR(annual) : '—'}`,
      ),
      ratePct: normalRate,
      warning: headroom && headroom.lte(thisBillBase)
        ? `Close to the annual limit: ${formatINR(headroom)} of headroom left. The bill that crosses it makes TDS due on the whole year's payments, not just the excess.`
        : undefined,
    }
  }

  // 4 ── 🔴 the crossing: deduct on everything paid this year, not just the excess
  const justCrossed = annual && cumulativeBefore.lte(annual) && cumulativeAfter.gt(annual)
  if (justCrossed) {
    const catchUp = round2(cumulativeAfter.mul(normalRate).div(100))
    return build(
      normalRate, cumulativeAfter,
      `Annual threshold crossed — deducting on the full ${formatINR(cumulativeAfter)} paid this year`,
      `This bill takes the vendor's FY total to ${formatINR(cumulativeAfter)}, crossing the ${formatINR(annual)} limit for ${sectionCode}. TDS is now due on the whole ${formatINR(cumulativeAfter)}, not just this bill — ${formatINR(catchUp)} in total.`,
    )
  }

  // 5 ── normal
  return build(normalRate, thisBillBase, overSingle && !overAnnual ? 'Single-payment threshold exceeded' : 'Normal rate')
}
