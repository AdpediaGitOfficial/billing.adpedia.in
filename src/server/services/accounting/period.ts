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
