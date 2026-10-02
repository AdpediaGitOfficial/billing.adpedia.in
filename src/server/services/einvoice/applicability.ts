import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { currentFinancialYear } from '@/server/services/accounting/period'

/**
 * Is e-invoicing applicable to this company yet?
 *
 * 🔴 This is the gate for the whole phase, and it is the part that matters TODAY. The
 * threshold has ratcheted down repeatedly — ₹500 Cr → 100 → 50 → 20 → 10 → ₹5 Cr — so the
 * question is not "does it apply" but "when will it", and the answer must come from the
 * ledger rather than from somebody's memory of last year.
 *
 * Registering invoices with the IRP when NOT liable is not a harmless precaution: an IRN
 * is a government record of a document, and generating them for a taxpayer outside the
 * mandate creates a reporting footprint that then has to be explained. So the system is
 * built, tested and switched OFF, and only this function can turn it on.
 */

/** Current e-invoicing threshold on aggregate turnover in ANY FY from 2017-18 onward. */
export const EINVOICE_THRESHOLD = new Decimal('50000000')      // ₹5 Cr
/** Same figure switches HSN/SAC reporting from 4 digits to 6. */
export const HSN6_THRESHOLD = new Decimal('50000000')
/** Warn well before the line, because the obligation starts immediately on crossing. */
const WARN_AT_PCT = new Decimal('75')

export interface YearTurnover {
  fyLabel: string
  turnover: Decimal
  crossed: boolean
}

export interface Applicability {
  /** highest aggregate turnover across any financial year on file */
  peakTurnover: Decimal
  peakFy: string | null
  currentFy: string | null
  currentTurnover: Decimal
  threshold: Decimal
  /** 🔴 liability is permanent once crossed — it does not lapse if turnover later falls */
  applicable: boolean
  /** within the warning band but not yet liable */
  approaching: boolean
  headroom: Decimal
  pctOfThreshold: Decimal
  hsn6Required: boolean
  years: YearTurnover[]
  /** what the system will actually do, in words */
  verdict: string
}

/**
 * Aggregate turnover, read from the ledger.
 *
 * "Aggregate turnover" under s.2(6) is all outward supplies — taxable, exempt, exports and
 * inter-state — on a PAN-India basis, excluding the taxes themselves. Revenue accounts hold
 * exactly that: GST is posted to its own liability accounts and never touches 4xxx.
 *
 * It is NOT the amount collected. A company can cross the threshold on invoices it has not
 * been paid for, and reading receipts instead would under-report and miss the crossing.
 */
export async function turnoverByYear(companyId: string): Promise<YearTurnover[]> {
  const years = await prisma.financialYear.findMany({
    where: { companyId }, orderBy: { startsOn: 'asc' },
  })

  const rows = await Promise.all(years.map(async (fy) => {
    const agg = await prisma.journalLine.aggregate({
      where: {
        account: { companyId, type: 'INCOME', code: { startsWith: '40' } },
        journalEntry: { companyId, date: { gte: fy.startsOn, lte: fy.endsOn } },
      },
      _sum: { credit: true, debit: true },
    })
    const turnover = new Decimal(agg._sum.credit?.toString() ?? '0')
      .minus(agg._sum.debit?.toString() ?? '0')
    return { fyLabel: fy.label, turnover, crossed: turnover.gte(EINVOICE_THRESHOLD) }
  }))

  return rows
}

export async function eInvoiceApplicability(ctx: RequestContext): Promise<Applicability> {
  assertCan(ctx.role, 'reports', 'read')

  const years = await turnoverByYear(ctx.companyId)
  const openFy = await currentFinancialYear(ctx.companyId)

  const peak = years.reduce<YearTurnover | null>(
    (best, y) => (!best || y.turnover.gt(best.turnover) ? y : best), null)
  const peakTurnover = peak?.turnover ?? ZERO
  const current = years.find((y) => y.fyLabel === openFy?.label)
  const currentTurnover = current?.turnover ?? ZERO

  // 🔴 Once any year crosses, the obligation stays — it does not switch off when a later
  // year is smaller. Reading only the current year would silently drop the requirement.
  const applicable = years.some((y) => y.crossed)
  const pctOfThreshold = EINVOICE_THRESHOLD.gt(0)
    ? peakTurnover.div(EINVOICE_THRESHOLD).mul(100)
    : ZERO
  const approaching = !applicable && pctOfThreshold.gte(WARN_AT_PCT)
  const headroom = Decimal.max(EINVOICE_THRESHOLD.minus(peakTurnover), ZERO)

  const verdict = applicable
    ? `Aggregate turnover reached ${inr(peakTurnover)} in FY ${peak?.fyLabel}. E-invoicing applies — every B2B, SEZ and export invoice must carry an IRN obtained BEFORE it is issued.`
    : approaching
      ? `Peak turnover ${inr(peakTurnover)} is ${pctOfThreshold.toFixed(0)}% of the ₹5 Cr threshold. ${inr(headroom)} of headroom left — prepare the IRP credentials now, because the obligation starts the moment it is crossed.`
      : `Peak turnover ${inr(peakTurnover)} against a ₹5 Cr threshold. E-invoicing does not apply, and no IRN will be generated.`

  return {
    peakTurnover, peakFy: peak?.fyLabel ?? null,
    currentFy: openFy?.label ?? null, currentTurnover,
    threshold: EINVOICE_THRESHOLD,
    applicable, approaching, headroom, pctOfThreshold,
    hsn6Required: years.some((y) => y.turnover.gte(HSN6_THRESHOLD)),
    years, verdict,
  }
}

function inr(v: Decimal): string {
  // crore/lakh reads better than nine digits when talking about a threshold
  if (v.gte('10000000')) return `₹${v.div('10000000').toFixed(2)} Cr`
  if (v.gte('100000')) return `₹${v.div('100000').toFixed(2)} L`
  return `₹${v.toFixed(0)}`
}

/**
 * The hard gate. Nothing in this module reaches the IRP unless BOTH are true:
 * the ledger says the company is liable, and someone has explicitly switched it on.
 */
export async function eInvoicingEnabled(ctx: RequestContext): Promise<{ enabled: boolean; reason: string }> {
  const a = await eInvoiceApplicability(ctx)
  if (!a.applicable) {
    return { enabled: false, reason: a.verdict }
  }
  if (process.env.EINVOICE_ENABLED !== 'true') {
    return {
      enabled: false,
      reason: 'E-invoicing now applies, but the IRP integration is switched off. Set EINVOICE_ENABLED and configure IRP credentials before the next invoice is issued.',
    }
  }
  return { enabled: true, reason: a.verdict }
}
