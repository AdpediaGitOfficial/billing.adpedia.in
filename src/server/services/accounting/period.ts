import { prisma, type Tx } from '@/server/db'
import { PeriodLocked, NotFound } from '@/server/errors'

const fmt = (d: Date) => d.toISOString().slice(0, 10)

/** Resolve the financial year containing `date`, for this company. */
export async function resolveFy(companyId: string, date: Date, tx: Tx = prisma) {
  const fy = await tx.financialYear.findFirst({
    where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } },
  })
  if (!fy) throw new NotFound(`No financial year covers ${fmt(date)} — create it in Settings first`)
  return fy
}

/**
 * The financial year we are standing in — docs/49.
 *
 * 🔴 Not "the newest OPEN year", which is what twenty-five call sites asked for. Next year's
 * row has to exist before April — the document series for it are created against it, and
 * numbering refuses without them — so the moment anyone creates FY 2027-28 in advance, every
 * one of those screens jumps to an empty future year: the dashboard, the GST position, the
 * PAN register, the compliance calendar. Nothing errors. The figures simply go to zero, in
 * October, with the real year still running.
 *
 * The year covering TODAY is the answer. The old behaviour survives only as the fallback for
 * when no year covers today at all — before the first one is created, after the last one
 * ends, or while standing inside a year that has been closed.
 */
export async function currentFinancialYear(companyId: string, on = new Date(), tx: Tx = prisma) {
  const covering = await tx.financialYear.findFirst({
    where: { companyId, startsOn: { lte: on }, endsOn: { gte: on } },
  })
  if (covering?.status === 'OPEN') return covering

  return tx.financialYear.findFirst({
    where: { companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' },
  })
}

export async function currentFinancialYearOrThrow(companyId: string, on = new Date(), tx: Tx = prisma) {
  const fy = await currentFinancialYear(companyId, on, tx)
  if (!fy) throw new NotFound('No open financial year — create one in Settings first')
  return fy
}

/**
 * 🔴 Called by EVERY posting path, without exception.
 * Recording a GST return as filed advances lockedUpTo to the end of that period — see
 * services/tax/gst-filing.ts. Until that was wired, this comment described an intention
 * rather than a behaviour.
 */
export async function assertPostable(companyId: string, date: Date, tx: Tx = prisma) {
  const fy = await resolveFy(companyId, date, tx)

  if (fy.status === 'CLOSED') {
    throw new PeriodLocked(`FY ${fy.label} is closed. Post the correction in an open year instead.`)
  }
  if (fy.lockedUpTo && date <= fy.lockedUpTo) {
    throw new PeriodLocked(
      `Period is locked to ${fmt(fy.lockedUpTo)}. Post a reversal in an open period instead of editing ${fmt(date)}.`,
    )
  }
  return fy
}
