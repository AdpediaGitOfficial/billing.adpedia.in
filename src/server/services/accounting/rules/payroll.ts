import { Decimal, ZERO } from '@/lib/money'
import type { Posting } from '../types'

export const PAYROLL_ACCOUNTS = {
  directorRemuneration: '5110',
  staffSalaries: '5120',
  tdsPayable192: '2210',
  professionTaxPayable: '2310',
  salaryPayable: '2300',
  bank: '1010',
} as const

export interface PayslipLine {
  employeeId: string
  isDirector: boolean
  gross: Decimal
  deductions: Decimal
  professionTax: Decimal
  tds: Decimal
  net: Decimal
}

/**
 * docs/12 §2.7. The director's remuneration is kept in its own account (5110) because
 * it is disclosed separately — mixing it into staff salaries makes the P&L misleading
 * and the related-party note harder to prepare.
 */
export function postPayrollRun(doc: { label: string; payslips: PayslipLine[] }): Posting[] {
  const postings: Posting[] = []

  let directorGross = ZERO, staffGross = ZERO, tdsTotal = ZERO, ptTotal = ZERO, netTotal = ZERO
  for (const p of doc.payslips) {
    if (p.isDirector) directorGross = directorGross.plus(p.gross)
    else staffGross = staffGross.plus(p.gross)
    tdsTotal = tdsTotal.plus(p.tds)
    ptTotal = ptTotal.plus(p.professionTax)
    netTotal = netTotal.plus(p.net)
  }

  if (directorGross.gt(0)) postings.push({ accountCode: PAYROLL_ACCOUNTS.directorRemuneration, debit: directorGross, narration: `Payroll ${doc.label}` })
  if (staffGross.gt(0)) postings.push({ accountCode: PAYROLL_ACCOUNTS.staffSalaries, debit: staffGross, narration: `Payroll ${doc.label}` })
  if (tdsTotal.gt(0)) postings.push({ accountCode: PAYROLL_ACCOUNTS.tdsPayable192, credit: tdsTotal, narration: 'TDS u/s 192' })
  if (ptTotal.gt(0)) postings.push({ accountCode: PAYROLL_ACCOUNTS.professionTaxPayable, credit: ptTotal, narration: 'Kerala profession tax' })
  if (netTotal.gt(0)) postings.push({ accountCode: PAYROLL_ACCOUNTS.salaryPayable, credit: netTotal })

  return postings
}

export function postSalaryPayment(doc: { label: string; amount: Decimal; bankAccountCode: string }): Posting[] {
  return [
    { accountCode: PAYROLL_ACCOUNTS.salaryPayable, debit: doc.amount, narration: `Salary paid — ${doc.label}` },
    { accountCode: doc.bankAccountCode, credit: doc.amount },
  ]
}
