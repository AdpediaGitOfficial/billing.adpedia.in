import type { GstFilingFrequency } from '@prisma/client'

export interface GstPeriod {
  label: string          // "2026-10" (monthly) | "2026-Q3" (quarterly)
  title: string          // "October 2026" | "Oct–Dec 2026"
  from: Date
  to: Date
  /** GSTR-1 due date. Monthly: 11th of the following month. QRMP: 13th after the quarter. */
  gstr1DueOn: Date
  /** GSTR-3B due date. Monthly: 20th. QRMP: 22nd or 24th by state group — Kerala is 24th. */
  gstr3bDueOn: Date
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Quarter of the FINANCIAL year: Q1 Apr–Jun … Q4 Jan–Mar. */
export function gstQuarterOf(date: Date): { q: 1 | 2 | 3 | 4; startMonth: number; year: number } {
  const m = date.getUTCMonth()       // 0-indexed
  const y = date.getUTCFullYear()
  if (m >= 3 && m <= 5) return { q: 1, startMonth: 3, year: y }
  if (m >= 6 && m <= 8) return { q: 2, startMonth: 6, year: y }
  if (m >= 9) return { q: 3, startMonth: 9, year: y }
  return { q: 4, startMonth: 0, year: y }
}

const endOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))

export function periodFor(date: Date, frequency: GstFilingFrequency): GstPeriod {
  if (frequency === 'MONTHLY') {
    const y = date.getUTCFullYear(), m = date.getUTCMonth()
    return {
      label: `${y}-${String(m + 1).padStart(2, '0')}`,
      title: `${MONTHS[m]} ${y}`,
      from: new Date(Date.UTC(y, m, 1)),
      to: endOfMonth(y, m),
      gstr1DueOn: new Date(Date.UTC(y, m + 1, 11)),
      gstr3bDueOn: new Date(Date.UTC(y, m + 1, 20)),
    }
  }

  const { q, startMonth, year } = gstQuarterOf(date)
  const from = new Date(Date.UTC(year, startMonth, 1))
  const to = endOfMonth(year, startMonth + 2)
  return {
    label: `${year}-Q${q}`,
    title: `${MONTHS[startMonth]}–${MONTHS[(startMonth + 2) % 12]} ${startMonth === 0 ? year : year}`,
    from,
    to,
    // QRMP: GSTR-1 (IFF/quarterly) by the 13th, GSTR-3B by the 22nd or 24th depending
    // on the state group. Kerala sits in the 24th group. ⚠️ confirm with the CA.
    gstr1DueOn: new Date(Date.UTC(year, startMonth + 3, 13)),
    gstr3bDueOn: new Date(Date.UTC(year, startMonth + 3, 24)),
  }
}

/** Every period in a financial year, oldest first. */
export function periodsInFy(fyStart: Date, fyEnd: Date, frequency: GstFilingFrequency): GstPeriod[] {
  const out: GstPeriod[] = []
  const seen = new Set<string>()
  const cursor = new Date(fyStart)
  while (cursor <= fyEnd) {
    const p = periodFor(cursor, frequency)
    if (!seen.has(p.label)) { seen.add(p.label); out.push(p) }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

export function daysUntil(due: Date, from = new Date()): number {
  return Math.ceil((due.getTime() - from.getTime()) / 86_400_000)
}
