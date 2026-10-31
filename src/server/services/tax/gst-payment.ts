import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { buildGstr3b } from './gstr3b'
import { assertGstRegistered } from './gst-registration'
import { periodsInFy } from './periods'
import { CASH_LEDGER_ACCOUNTS } from './gst-ledger'
import { cashLedgerBalance } from './gst-electronic-ledgers'
import { gstr3bDue } from '@/server/services/compliance/deadlines'
import { currentFinancialYear } from '@/server/services/accounting/period'

/**
 * Funding the electronic cash ledger — Form PMT-06.
 *
 * 🔴 A return being *filed* and the tax being *paid* are different events, and until this
 * module the system only knew about the first — so a filed-but-unpaid return looked settled.
 * Under QRMP they are not even on the same cadence: PMT-06 payments fall monthly while the
 * return is quarterly.
 *
 * 🔴 And a challan is not a discharge either (docs/46). It CREDITS the electronic cash
 * ledger, which in double entry is a debit to an asset the company still owns; the liability
 * goes down later, when the return is offset. That matters for three reasons: money deposited
 * and not yet offset is refundable under s.54(1); cash under one major head cannot pay
 * another; and under rule 88B(1) interest runs until the cash ledger is DEBITED, so funding
 * it early does not stop the clock.
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
  /** 🔴 what to deposit per major head — a deposit under the wrong head cannot pay the right one */
  deposit: { igst: Decimal; cgst: Decimal; sgst: Decimal; total: Decimal }
  /** what is already sitting in the cash ledger, head-wise */
  cashLedger: { igst: Decimal; cgst: Decimal; sgst: Decimal; other: Decimal }
  warnings: string[]
}

export async function previewGstPayment(
  ctx: RequestContext, periodLabel: string, paidOn: Date,
): Promise<GstPaymentPreview> {
  assertCan(ctx.role, 'tax', 'read')

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstFilingFrequency: true, stateCode: true },
  })
  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) throw new NotFound('No open financial year')

  const period = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
    .find((p) => p.label === periodLabel)
  if (!period) throw new AppError(`${periodLabel} is not a filing period for FY ${fy.label}`)

  const r = await buildGstr3b(ctx.companyId, period.from, period.to, period.label)
  const dueOn = gstr3bDue(period.to, company.gstFilingFrequency === 'QUARTERLY', company.stateCode)

  const [paid, cashLedger] = await Promise.all([
    prisma.gstChallan.aggregate({
      where: { companyId: ctx.companyId, periodLabel }, _sum: { amount: true },
    }),
    cashLedgerBalance(ctx.companyId, paidOn),
  ])
  const alreadyPaid = new Decimal(paid._sum.amount?.toString() ?? '0')

  // 🔴 Head-wise, and net of what the cash ledger already holds. The portal will not let
  // CGST cash discharge an SGST liability, so a single total is not a usable instruction —
  // a challan raised against the wrong head has to be moved with Form PMT-09.
  const need = (required: Decimal, have: Decimal) => Decimal.max(required.minus(have), ZERO)
  const deposit = {
    igst: need(r.payable.byHead.igst.inCash.plus(r.payable.rcmInCash), cashLedger.igst),
    cgst: need(r.payable.byHead.cgst.inCash, cashLedger.cgst),
    sgst: need(r.payable.byHead.sgst.inCash, cashLedger.sgst),
    total: ZERO as Decimal,
  }
  deposit.total = deposit.igst.plus(deposit.cgst).plus(deposit.sgst)

  const cashPayable = r.payable.inCash.plus(r.payable.rcmInCash)
  const interest = gstInterest(r.payable.inCash, dueOn, paidOn)

  const warnings: string[] = []
  if (r.payable.rcmInCash.gt(0)) {
    warnings.push(
      `${formatINR(r.payable.rcmInCash)} of reverse-charge IGST must be paid in cash — it can never be set off against input credit, however much credit is available.`,
    )
  }
  const stranded = r.payable.strandedCredit
  if (stranded.cgst.gt(0) && r.payable.byHead.sgst.inCash.gt(0)) {
    warnings.push(
      `${formatINR(stranded.cgst)} of CGST credit cannot be used for the SGST liability (s.49(5)(e)), so ` +
      `${formatINR(r.payable.byHead.sgst.inCash)} of SGST has to be funded in cash even though there is credit on hand.`,
    )
  }
  if (stranded.sgst.gt(0) && r.payable.byHead.cgst.inCash.gt(0)) {
    warnings.push(
      `${formatINR(stranded.sgst)} of SGST credit cannot be used for the CGST liability (s.49(5)(f)), so ` +
      `${formatINR(r.payable.byHead.cgst.inCash)} of CGST has to be funded in cash even though there is credit on hand.`,
    )
  }
  const filed = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel, returnType: 'GSTR3B', status: 'FILED' },
  })
  if (!filed) {
    warnings.push('GSTR-3B for this period is not recorded as filed yet. Paying first is normal — the return cannot be filed until the cash ledger is funded.')
  }
  // 🔴 Rule 88B(1): the clock stops when the cash ledger is DEBITED, which is the set-off.
  warnings.push(
    'A challan funds the cash ledger; it does not discharge anything. Record the set-off to debit the ledger — ' +
    'until then the liability stands and, under rule 88B(1), the interest keeps running.',
  )

  return {
    periodLabel, dueOn,
    cashPayable, rcmInCash: r.payable.rcmInCash, throughItc: r.payable.throughItc,
    interest, alreadyPaid,
    outstanding: Decimal.max(cashPayable.plus(interest.interest).minus(alreadyPaid), ZERO),
    deposit, cashLedger,
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
  await assertGstRegistered(ctx.companyId, 'a GST challan')

  const paidOn = new Date(input.paidOn)
  if (Number.isNaN(paidOn.getTime())) throw new AppError('That is not a valid payment date')
  const fy = await assertPostable(ctx.companyId, paidOn)

  // 🔴 A blank field is zero, not a crash. Leaving CGST empty on a challan that is all IGST
  // is the normal way to fill this form, and `new Decimal('')` throws a DecimalError that no
  // handler recognises — so the screen said only "could not record that payment".
  const d = (v?: string) => {
    const raw = (v ?? '').trim().replace(/,/g, '')
    if (raw === '') return ZERO
    // Decimal throws its own error on anything unparseable, and that one reaches the user
    // as "could not record that payment" — which says nothing about which field is wrong.
    let n: Decimal
    try { n = new Decimal(raw) } catch { throw new AppError(`"${v}" is not an amount a challan can carry`) }
    if (!n.isFinite() || n.isNegative()) throw new AppError(`"${v}" is not an amount a challan can carry`)
    return round2(n)
  }
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

    // 🔴 The challan credits the electronic CASH LEDGER, head-wise — it does not touch the
    // output-tax liability. Debiting 2110/2120/2130 here (as this did before docs/46) made a
    // funded-but-unoffset period read as settled, overstated what had been discharged, and
    // let cash deposited under one major head appear to cover another.
    //
    // Reverse charge is deposited under the IGST major head: it is cash-only because credit
    // cannot discharge it, not because it has a head of its own.
    const toIgst = igst.plus(rcm)
    const toOther = interest.plus(lateFee)

    await postJournal(ctx, {
      date: paidOn,
      narration: `GST deposit (PMT-06) for ${input.periodLabel} — CIN ${cin}`,
      sourceType: 'GST_PAYMENT', sourceId: row.id,
      postings: [
        ...(cgst.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.cgst, debit: cgst }] : []),
        ...(sgst.gt(0) ? [{ accountCode: CASH_LEDGER_ACCOUNTS.sgst, debit: sgst }] : []),
        ...(toIgst.gt(0)
          ? [{ accountCode: CASH_LEDGER_ACCOUNTS.igst, debit: toIgst, narration: rcm.gt(0) ? `includes ${rcm.toFixed(2)} reverse charge` : undefined }]
          : []),
        // interest and late fee go in under the minor head. They become an EXPENSE when the
        // ledger is debited at set-off — until then they are money the company still holds.
        ...(toOther.gt(0)
          ? [{ accountCode: CASH_LEDGER_ACCOUNTS.other, debit: toOther, narration: 'interest and late fee' }]
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
