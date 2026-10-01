import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { isValidPanFormat } from './pan'
import { returnDueDate, certificateDueDate, computeLateFee, depositDueDate } from './tds-challan'
import { csvCell } from '@/lib/csv'

export type ReturnForm = '24Q' | '26Q' | '27Q'

/** Which form a section is reported in. */
export function formForSection(code: string): ReturnForm {
  if (code === '192') return '24Q'
  if (code === '195') return '27Q'
  return '26Q'
}

export interface DeducteeRow {
  deducteeName: string
  deducteePan: string | null
  sectionCode: string
  paidOn: Date
  amountPaid: Decimal
  tdsDeducted: Decimal
  ratePct: Decimal
  challanBsr: string | null
  challanSerial: string | null
  challanDate: Date | null
  /** blank when no PAN — the return then has to carry the higher-rate flag */
  reasonCode: string | null
}

export interface ChallanRow {
  bsrCode: string
  challanSerial: string
  depositedOn: Date
  amount: Decimal
  interest: Decimal
  lateFee: Decimal
  cin: string | null
  deducteeCount: number
  /** challan.amount must equal the sum of the deductions it covers */
  deductionTotal: Decimal
  reconciles: boolean
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  deductee?: string
}

export interface TdsReturn {
  form: ReturnForm
  fyLabel: string
  quarter: 1 | 2 | 3 | 4
  tan: string | null
  dueOn: Date
  certificateDueOn: Date
  deductees: DeducteeRow[]
  challans: ChallanRow[]
  totals: { amountPaid: Decimal; tdsDeducted: Decimal; challanTotal: Decimal }
  issues: ValidationIssue[]
  /** false when any error-severity issue remains */
  readyToFile: boolean
  lateFee: { fee: Decimal; days: number; capped: boolean } | null
}

/**
 * 🔴 An EXPORT FOR THE CA, not an FVU file.
 *
 * NSDL's RPU and FVU formats are versioned and break silently; generating them here means
 * a failure discovered at the filing deadline. What this does instead is produce a clean,
 * validated deductee-wise CSV that the CA imports into the RPU — and run the pre-flight
 * checks that catch 90% of rejections before they happen (docs/02 §B2).
 */
export async function buildTdsReturn(
  ctx: RequestContext, form: ReturnForm, fyLabel: string, quarter: 1 | 2 | 3 | 4, asOf = new Date(),
): Promise<TdsReturn> {
  assertCan(ctx.role, 'tax', 'read')

  const [company, fy] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
    prisma.financialYear.findFirstOrThrow({ where: { companyId: ctx.companyId, label: fyLabel } }),
  ])

  const sections = form === '24Q' ? ['192'] : form === '27Q' ? ['195'] : undefined
  const deductions = await prisma.tdsDeduction.findMany({
    where: {
      companyId: ctx.companyId, financialYearId: fy.id, quarter, reversedAt: null,
      ...(sections ? { sectionCode: { in: sections } } : { sectionCode: { notIn: ['192', '195'] } }),
    },
    include: {
      vendor: { select: { name: true, pan: true, panVerified: true } },
      employee: { select: { name: true, pan: true } },
      challan: true,
    },
    orderBy: [{ deductedOn: 'asc' }],
  })

  const issues: ValidationIssue[] = []
  const deductees: DeducteeRow[] = deductions.map((d) => {
    const name = d.vendor?.name ?? d.employee?.name ?? 'Unknown deductee'
    const pan = d.deducteePan ?? d.vendor?.pan ?? d.employee?.pan ?? null

    if (!pan) {
      issues.push({ severity: 'error', code: 'NO_PAN', deductee: name,
        message: `${name} has no PAN. The return cannot be filed without one, and s.206AA requires deduction at 20%.` })
    } else if (!isValidPanFormat(pan)) {
      issues.push({ severity: 'error', code: 'BAD_PAN', deductee: name,
        message: `${name}: "${pan}" is not a valid PAN format — five letters, four digits, one letter.` })
    }

    if (!d.challanId) {
      issues.push({ severity: 'error', code: 'NO_CHALLAN', deductee: name,
        message: `${name}: ₹${d.tdsAmount} deducted on ${d.deductedOn.toISOString().slice(0, 10)} is not linked to a challan. Every deduction in the return must be.` })
    } else if (d.challan && d.challan.depositedOn > depositDueDate(d.deductedOn)) {
      issues.push({ severity: 'warning', code: 'LATE_DEPOSIT', deductee: name,
        message: `${name}: deposited ${d.challan.depositedOn.toISOString().slice(0, 10)}, due ${depositDueDate(d.deductedOn).toISOString().slice(0, 10)}. Interest under s.201(1A) applies.` })
    }

    return {
      deducteeName: name, deducteePan: pan,
      sectionCode: d.sectionCode, paidOn: d.deductedOn,
      amountPaid: new Decimal(d.baseAmount.toString()),
      tdsDeducted: new Decimal(d.tdsAmount.toString()),
      ratePct: new Decimal(d.ratePct.toString()),
      challanBsr: d.challan?.bsrCode ?? null,
      challanSerial: d.challan?.challanSerial ?? null,
      challanDate: d.challan?.depositedOn ?? null,
      reasonCode: pan && isValidPanFormat(pan) ? null : 'C',   // 'C' = higher rate, no PAN
    }
  })

  // ── challans in this quarter, and whether each reconciles ──
  const challanIds = [...new Set(deductions.map((d) => d.challanId).filter(Boolean) as string[])]
  const challanRows = await prisma.tdsChallan.findMany({
    where: { id: { in: challanIds } },
    include: { deductions: { where: { reversedAt: null } } },
  })

  const challans: ChallanRow[] = challanRows.map((c) => {
    const deductionTotal = c.deductions.reduce((a, d) => a.plus(d.tdsAmount.toString()), ZERO)
    const amount = new Decimal(c.amount.toString())
    const reconciles = amount.equals(deductionTotal)
    if (!reconciles) {
      issues.push({ severity: 'error', code: 'CHALLAN_MISMATCH',
        message: `Challan ${c.cin ?? c.challanSerial}: ₹${amount.toFixed(2)} deposited but ₹${deductionTotal.toFixed(2)} of deductions are linked. The RPU will reject this.` })
    }
    return {
      bsrCode: c.bsrCode, challanSerial: c.challanSerial, depositedOn: c.depositedOn,
      amount, interest: new Decimal(c.interest.toString()), lateFee: new Decimal(c.lateFee.toString()),
      cin: c.cin, deducteeCount: c.deductions.length, deductionTotal, reconciles,
    }
  })

  if (!company.tan) {
    issues.push({ severity: 'error', code: 'NO_TAN', message: 'No TAN on the company record. A TDS return cannot be filed without it.' })
  }

  const totals = {
    amountPaid: deductees.reduce((a, d) => a.plus(d.amountPaid), ZERO),
    tdsDeducted: deductees.reduce((a, d) => a.plus(d.tdsDeducted), ZERO),
    challanTotal: challans.reduce((a, c) => a.plus(c.amount), ZERO),
  }

  if (deductees.length > 0 && !totals.tdsDeducted.equals(totals.challanTotal)) {
    issues.push({ severity: 'error', code: 'TOTAL_MISMATCH',
      message: `Deductions total ₹${totals.tdsDeducted.toFixed(2)} but challans total ₹${totals.challanTotal.toFixed(2)}. They must agree before filing.` })
  }

  const fyStartYear = Number(fyLabel.split('-')[0])
  const dueOn = returnDueDate(fyStartYear, quarter)
  const lateFee = asOf > dueOn && totals.tdsDeducted.gt(0)
    ? computeLateFee({ tdsInReturn: totals.tdsDeducted, dueOn, filedOn: asOf })
    : null
  if (lateFee && lateFee.fee.gt(0)) {
    issues.push({ severity: 'warning', code: 'LATE_FILING',
      message: `${lateFee.days} days past the due date of ${dueOn.toISOString().slice(0, 10)} — s.234E late fee of ₹${lateFee.fee.toFixed(2)}${lateFee.capped ? ', capped at the TDS in the return' : ' and rising ₹200 a day'}.` })
  }

  return {
    form, fyLabel, quarter, tan: company.tan,
    dueOn, certificateDueOn: certificateDueDate(fyStartYear, quarter),
    deductees, challans, totals, issues,
    readyToFile: issues.every((i) => i.severity !== 'error') && deductees.length > 0,
    lateFee,
  }
}

const row = (cells: unknown[]) => cells.map(csvCell).join(',')

export function tdsReturnToCsv(r: TdsReturn): string {
  const out: string[] = []
  out.push(`# Form ${r.form} — FY ${r.fyLabel} Q${r.quarter}`)
  out.push(`# TAN,${r.tan ?? 'MISSING'}`)
  out.push(`# Return due,${r.dueOn.toISOString().slice(0, 10)}`)
  out.push(`# Form 16${r.form === '24Q' ? '' : 'A'} due,${r.certificateDueOn.toISOString().slice(0, 10)}`)
  out.push(`# Generated,${new Date().toISOString().slice(0, 10)}`)
  out.push('# Prepared for import into the RPU — this is not an FVU file')
  out.push(`# Pre-flight,${r.readyToFile ? 'PASSED' : 'FAILED — see the issues section'}`)

  out.push('', '# deductees')
  out.push(row(['Deductee Name', 'PAN', 'Section', 'Date of Payment', 'Amount Paid', 'TDS Deducted', 'Rate %', 'BSR Code', 'Challan Serial', 'Challan Date', 'Reason Code']))
  for (const d of r.deductees) {
    out.push(row([d.deducteeName, d.deducteePan, d.sectionCode, d.paidOn, d.amountPaid.toFixed(2), d.tdsDeducted.toFixed(2), d.ratePct.toFixed(2), d.challanBsr, d.challanSerial, d.challanDate, d.reasonCode]))
  }

  out.push('', '# challans')
  out.push(row(['BSR Code', 'Challan Serial', 'Date of Deposit', 'TDS', 'Interest', 'Late Fee', 'Total', 'CIN', 'Deductees', 'Reconciles']))
  for (const c of r.challans) {
    out.push(row([c.bsrCode, c.challanSerial, c.depositedOn, c.amount.toFixed(2), c.interest.toFixed(2), c.lateFee.toFixed(2), c.amount.plus(c.interest).plus(c.lateFee).toFixed(2), c.cin, c.deducteeCount, c.reconciles ? 'yes' : 'NO']))
  }

  out.push('', '# totals')
  out.push(row(['Amount Paid', r.totals.amountPaid.toFixed(2)]))
  out.push(row(['TDS Deducted', r.totals.tdsDeducted.toFixed(2)]))
  out.push(row(['Challans', r.totals.challanTotal.toFixed(2)]))

  if (r.issues.length > 0) {
    out.push('', '# issues — resolve the errors before filing')
    out.push(row(['Severity', 'Code', 'Deductee', 'Message']))
    for (const i of r.issues) out.push(row([i.severity, i.code, i.deductee, i.message]))
  }
  return out.join('\n') + '\n'
}
