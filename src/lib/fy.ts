/**
 * Indian financial year: 1 April → 31 March.
 * FY is a first-class row in the DB; these helpers derive labels and boundaries.
 */

export function fyLabelFor(date: Date, startMonth = 4): string {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  const start = m >= startMonth ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

export function fyBounds(label: string): { startsOn: Date; endsOn: Date } {
  const start = Number(label.split('-')[0])
  return {
    startsOn: new Date(Date.UTC(start, 3, 1, 0, 0, 0)),
    endsOn: new Date(Date.UTC(start + 1, 2, 31, 23, 59, 59)),
  }
}

/** TDS return quarter: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. */
export function fyQuarter(date: Date): 1 | 2 | 3 | 4 {
  const m = date.getUTCMonth() + 1
  if (m >= 4 && m <= 6) return 1
  if (m >= 7 && m <= 9) return 2
  if (m >= 10 && m <= 12) return 3
  return 4
}

/** TDS deposit due: 7th of the following month, except March which is 30 April. */
export function tdsDepositDueDate(deductionDate: Date): Date {
  const y = deductionDate.getUTCFullYear()
  const m = deductionDate.getUTCMonth() + 1
  if (m === 3) return new Date(Date.UTC(y, 3, 30))
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7))
}

/**
 * Document numbers use the SHORT financial-year form.
 * The stored label is "2026-27" (7 chars); invoice numbers carry "26-27" (5),
 * which is what keeps ADP/26-27/0026 inside the Rule 46 limit of 16 characters.
 */
export function shortFy(label: string): string {
  const [start, end] = label.split('-')
  return `${start.slice(-2)}-${end}`
}
