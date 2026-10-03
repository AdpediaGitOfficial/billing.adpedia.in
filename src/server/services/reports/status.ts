import { prisma } from '@/server/db'
import type { Period } from './ledger'

/**
 * Is this statement final, or is it still moving? — docs/58.
 *
 * 🔴 Every statement this system has produced until now has been silent about this, and it
 * is the first thing a reader needs. A profit figure for the year to date, emailed to a bank
 * in October, is not the year's profit: the books are open, and anything in it can change
 * before March. The CSVs said nothing; the screen said nothing.
 *
 * The system already knows. A financial year is CLOSED, or its `lockedUpTo` covers the
 * period, or it does not — so the document says which, in those words, on its face.
 */
export type StatementStatus = 'FINAL' | 'LOCKED' | 'DRAFT'

export interface StatementStanding {
  status: StatementStatus
  label: string
  note: string
  lockedUpTo: Date | null
}

export async function statementStanding(companyId: string, period: Period): Promise<StatementStanding> {
  const fy = await prisma.financialYear.findFirst({
    where: { companyId, startsOn: { lte: period.to }, endsOn: { gte: period.from } },
    orderBy: { startsOn: 'desc' },
  })

  if (!fy) {
    return {
      status: 'DRAFT', label: 'Draft', lockedUpTo: null,
      note: 'No financial year on file covers this period, so nothing here is locked against change.',
    }
  }

  if (fy.status === 'CLOSED') {
    return {
      status: 'FINAL', label: 'Final', lockedUpTo: fy.lockedUpTo,
      note: `The books for FY ${fy.label} are closed. These figures cannot change without a reversal, which would appear as its own entry.`,
    }
  }

  // 🔴 locked UP TO a date — a statement ending on or before it cannot move; one ending
  // after it covers days that are still open, however much of it is locked.
  if (fy.lockedUpTo && fy.lockedUpTo >= period.to) {
    return {
      status: 'LOCKED', label: 'Locked', lockedUpTo: fy.lockedUpTo,
      note: `The books are locked up to ${fy.lockedUpTo.toISOString().slice(0, 10)}, which covers this whole period. ` +
        `FY ${fy.label} is not closed, so later periods can still move.`,
    }
  }

  return {
    status: 'DRAFT', label: 'Draft — books are open', lockedUpTo: fy.lockedUpTo,
    note: fy.lockedUpTo
      ? `The books are locked only up to ${fy.lockedUpTo.toISOString().slice(0, 10)}. Everything after that date can still change, so this statement is not final.`
      : `FY ${fy.label} is open and nothing is locked. Every figure here can still change — this is a working statement, not a final one.`,
  }
}
