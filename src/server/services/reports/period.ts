import { prisma } from '@/server/db'
import type { Period } from './ledger'

export interface ResolvedPeriod extends Period {
  label: string
  fyLabel: string
  fyStart: Date
  fyId: string
  /** every FY on file, newest first, for the picker */
  options: { id: string; label: string }[]
}

/**
 * Reports default to the open financial year. Indian statutory reporting is annual and
 * the year is April–March, so "this year" is the only default that is ever right here.
 */
export async function resolvePeriod(companyId: string, fyId?: string): Promise<ResolvedPeriod> {
  const years = await prisma.financialYear.findMany({
    where: { companyId },
    orderBy: { startsOn: 'desc' },
  })
  const fy = (fyId ? years.find((y) => y.id === fyId) : undefined)
    ?? years.find((y) => y.status === 'OPEN')
    ?? years[0]

  if (!fy) {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), 3, 1))
    return {
      from: start, to: now, label: 'No financial year on file',
      fyLabel: '—', fyStart: start, fyId: '', options: [],
    }
  }

  return {
    from: fy.startsOn, to: fy.endsOn,
    label: `FY ${fy.label}`, fyLabel: fy.label, fyStart: fy.startsOn, fyId: fy.id,
    options: years.map((y) => ({ id: y.id, label: `FY ${y.label}` })),
  }
}
