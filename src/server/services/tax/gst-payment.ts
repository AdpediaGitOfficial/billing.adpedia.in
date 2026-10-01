import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { buildGstr3b } from './gstr3b'
import { periodsInFy } from './periods'
import { gstr3bDue } from '@/server/services/compliance/deadlines'

/**
 * Paying GST.
 *
 * 🔴 A return being *filed* and the tax being *paid* are different events, and until now the
 * system only knew about the first — so a filed-but-unpaid return looked settled. Under QRMP
 * they are not even on the same cadence: PMT-06 payments fall monthly while the return is
 * quarterly.
 */

/** s.50(1) — interest on tax paid late. */
export const GST_INTEREST_PCT = new Decimal('18')

export interface InterestResult {
  days: number
  base: Decimal
  interest: Decimal
  note: string
}

/**
 * 🔴 Interest runs on the CASH component, not on the gross liability.
 *
 * This is the proviso to s.50(1), and it is the part people get wrong. Where a return is
 * filed late, interest is charged only on the portion of tax paid **through the electronic
 * cash ledger** — not on the amount set off against input credit that was sitting there all
 * along. Charging on the gross figure can easily double the interest on a company with
 * substantial ITC.
 *
 * It is simple interest, per day, at 18% a year.
 */
export function gstInterest(cashPayable: Decimal, dueOn: Date, paidOn: Date): InterestResult {
  const DAY = 86_400_000
  const days = Math.max(0, Math.ceil((paidOn.getTime() - dueOn.getTime()) / DAY))
  if (days === 0 || cashPayable.lte(0)) {
    return { days: 0, base: Decimal.max(cashPayable, ZERO), interest: ZERO, note: 'Paid on time — no interest' }
  }
  const interest = round2(cashPayable.mul(GST_INTEREST_PCT).div(100).mul(days).div(365))
  return {
    days,
    base: cashPayable,
    interest,
    note: `${days} days late on ${cashPayable.toFixed(2)} of cash liability at 18% a year (s.50(1)). ` +
      'Interest runs on the cash component only — not on tax set off against input credit.',
  }
}

export interface GstPaymentPreview {
  periodLabel: string
  dueOn: Date
  /** what the return says is payable in cash */
  cashPayable: Decimal
  rcmInCash: Decimal
  throughItc: Decimal
  interest: InterestResult
  alreadyPaid: Decimal
  outstanding: Decimal
  warnings: string[]
}

export async function previewGstPayment(
  ctx: RequestContext, periodLabel: string, paidOn: Date,
): Promise<GstPaymentPreview> {
  assertCan(ctx.role, 'tax', 'read')

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstFilingFrequency: true, stateCode: true },
  })
  const fy = await prisma.financialYear.findFirst({
    where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' },
  })
  if (!fy) throw new NotFound('No open financial year')

  const period = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
    .find((p) => p.label === periodLabel)
  if (!period) throw new AppError(`${periodLabel} is not a filing period for FY ${fy.label}`)

  const r = await buildGstr3b(ctx.companyId, period.from, period.to, period.label)
  const dueOn = gstr3bDue(period.to, company.gstFilingFrequency === 'QUARTERLY', company.stateCode)

  const paid = await prisma.gstChallan.aggregate({
    where: { companyId: ctx.companyId, periodLabel }, _sum: { amount: true },
  })
  const alreadyPaid = new Decimal(paid._sum.amount?.toString() ?? '0')

  const cashPayable = r.payable.inCash.plus(r.payable.rcmInCash)
  const interest = gstInterest(r.payable.inCash, dueOn, paidOn)

  const warnings: string[] = []
  if (r.payable.rcmInCash.gt(0)) {
    warnings.push(
      `${r.payable.rcmInCash.toFixed(2)} of reverse-charge IGST must be paid in cash — it can never be set off against input credit, however much credit is available.`,
    )
  }
  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel, returnType: 'GSTR3B', status: 'FILED' },
  })
  if (!filed) {
    warnings.push('GSTR-3B for this period is not recorded as filed yet. Paying first is normal — the return cannot be filed until the cash ledger is funded.')
  }

  return {
    periodLabel, dueOn,
    cashPayable, rcmInCash: r.payable.rcmInCash, throughItc: r.payable.throughItc,
    interest, alreadyPaid,
    outstanding: Decimal.max(cashPayable.plus(interest.interest).minus(alreadyPaid), ZERO),
    warnings,
  }
}

export interface RecordPaymentInput {
  periodLabel: string
  paidOn: string
  cpin?: string
  cin?: string
  igst?: string
  cgst?: string
  sgst?: string
  rcm?: string
  interest?: string
  lateFee?: string
  bankAccountId?: string
}

/**
 * Record a GST payment and post it.
 *
 * The journal debits the output-tax liabilities being settled and credits the bank. Interest
 * and late fee are an expense, not a reduction of tax — they are not creditable to anyone and
 * belong in the P&L where they can be seen.
 */
export async function recordGstPayment(ctx: RequestContext, input: RecordPaymentInput) {
  assertCan(ctx.role, 'tax', 'write')

  const paidOn = new Date(input.paidOn)
  if (Number.isNaN(paidOn.getTime())) throw new AppError('That is not a valid payment date')
  const fy = await assertPostable(ctx.companyId, paidOn)

  const d = (v?: string) => round2(new Decimal(v ?? '0'))
  const igst = d(input.igst), cgst = d(input.cgst), sgst = d(input.sgst), rcm = d(input.rcm)
  const interest = d(input.interest), lateFee = d(input.lateFee)
  const tax = igst.plus(cgst).plus(sgst).plus(rcm)
  const amount = tax.plus(interest).plus(lateFee)

  if (amount.lte(0)) throw new AppError('A challan needs an amount')

  // 🔴 CIN is the bank's confirmation that money actually moved. A challan generated but not
  // paid has a CPIN only — recording that as a payment would make an unpaid liability look
  // settled, which is the exact failure this module exists to fix.
  const cin = input.cin?.trim()
  if (!cin) {
    throw new AppError(
      'A payment needs its CIN — the challan identification number the bank returns once the money has actually moved. A CPIN alone means the challan was generated, not paid.',
    )
  }

  const bank = input.bankAccountId
    ? await prisma.companyBankAccount.findFirstOrThrow({
        where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true },
      })
    : await prisma.companyBankAccount.findFirstOrThrow({
        where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true },
      })
  if (!bank.ledgerAccount) throw new AppError(`${bank.label} is not mapped to a ledger account`)

  const challan = await prisma.$transaction(async (tx) => {
    const row = await tx.gstChallan.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, periodLabel: input.periodLabel,
        cpin: input.cpin?.trim() || null, cin, paidOn,
        igst: igst.toFixed(2), cgst: cgst.toFixed(2), sgst: sgst.toFixed(2), rcm: rcm.toFixed(2),
        interest: interest.toFixed(2), lateFee: lateFee.toFixed(2),
        amount: amount.toFixed(2), bankAccountId: bank.id,
      },
    })

    await postJournal(ctx, {
      date: paidOn,
      narration: `GST payment for ${input.periodLabel} — CIN ${cin}`,
      sourceType: 'GST_PAYMENT', sourceId: row.id,
      postings: [
        ...(cgst.gt(0) ? [{ accountCode: '2110', debit: cgst }] : []),
        ...(sgst.gt(0) ? [{ accountCode: '2120', debit: sgst }] : []),
        ...(igst.gt(0) ? [{ accountCode: '2130', debit: igst }] : []),
        ...(rcm.gt(0) ? [{ accountCode: '2140', debit: rcm }] : []),
        // interest and late fee are a cost, not tax — nobody can claim them
        ...(interest.plus(lateFee).gt(0)
          ? [{ accountCode: '5600', debit: interest.plus(lateFee), narration: 'GST interest and late fee' }]
          : []),
        { accountCode: bank.ledgerAccount!.code, credit: amount },
      ],
    }, tx)

    return row
  })

  await audit(ctx, {
    entity: 'GstChallan', entityId: challan.id, action: 'POST',
    after: { period: input.periodLabel, cin: challan.cin, amount: amount.toFixed(2) },
  })
  return challan
}

export async function listGstChallans(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  return prisma.gstChallan.findMany({
    where: { companyId: ctx.companyId }, orderBy: { paidOn: 'desc' },
  })
}

/** Which periods have a payment against them — the calendar asks. */
export async function paidPeriods(companyId: string): Promise<Set<string>> {
  const rows = await prisma.gstChallan.findMany({
    where: { companyId, cin: { not: null } }, select: { periodLabel: true },
  })
  return new Set(rows.map((r) => r.periodLabel))
}
