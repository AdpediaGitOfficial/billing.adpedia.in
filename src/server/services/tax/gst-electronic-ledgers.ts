import { prisma } from '@/server/db'
import { Decimal, ZERO, round2, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { GST_ACCOUNTS, CASH_LEDGER_ACCOUNTS } from './gst-ledger'
import type { CashHeads, CreditHeads } from './gst-setoff-engine'

/**
 * The electronic cash and credit ledgers — PMT-05 and the credit ledger the portal keeps.
 *
 * 🔴 They are DERIVED, not stored. Every rupee in either one arrives by a journal posting:
 * a challan debits a cash-ledger head, a vendor bill debits a credit-ledger head, a set-off
 * credits both. So the ledgers are a reading of the journal, exactly like every report in
 * this system — which is the only way they can never disagree with the trial balance.
 *
 * Both are kept HEAD-WISE because the law is head-wise. CGST credit cannot pay SGST
 * (s.49(5)(e)), and cash under one major head cannot pay another without Form PMT-09 — so a
 * single total would hide the one thing the ledgers exist to show.
 */

export type LedgerKind = 'CASH' | 'CREDIT'

export interface LedgerHead {
  key: string
  label: string
  accountCode: string
  opening: Decimal
  credited: Decimal
  debited: Decimal
  closing: Decimal
}

export interface LedgerStatementLine {
  date: Date
  entryNo: number
  narration: string
  head: string
  sourceType: string
  /** money INTO the ledger — a challan deposit, or ITC accruing */
  credited: Decimal
  /** money OUT of the ledger — a set-off */
  debited: Decimal
  balance: Decimal
}

export interface ElectronicLedger {
  kind: LedgerKind
  title: string
  heads: LedgerHead[]
  total: { opening: Decimal; credited: Decimal; debited: Decimal; closing: Decimal }
  lines: LedgerStatementLine[]
  notes: string[]
}

/**
 * 🔴 The portal's vocabulary is the mirror image of ours, and mixing them up is how a
 * ledger ends up backwards. A *credit* to the electronic cash ledger is money going IN —
 * which in double entry is a DEBIT to the asset. So the portal's "credit" column is our
 * debit column, and the portal's "debit" column is where a set-off consumes the balance.
 */
const CASH_HEADS = [
  { key: 'igst', label: 'IGST', accountCode: CASH_LEDGER_ACCOUNTS.igst },
  { key: 'cgst', label: 'CGST', accountCode: CASH_LEDGER_ACCOUNTS.cgst },
  { key: 'sgst', label: 'SGST', accountCode: CASH_LEDGER_ACCOUNTS.sgst },
  { key: 'other', label: 'Interest, fee & penalty', accountCode: CASH_LEDGER_ACCOUNTS.other },
] as const

const CREDIT_HEADS = [
  { key: 'igst', label: 'IGST', accountCode: GST_ACCOUNTS.inputIgst },
  { key: 'igstRcm', label: 'IGST — reverse charge', accountCode: GST_ACCOUNTS.rcmItc },
  { key: 'cgst', label: 'CGST', accountCode: GST_ACCOUNTS.inputCgst },
  { key: 'sgst', label: 'SGST', accountCode: GST_ACCOUNTS.inputSgst },
] as const

async function headBalances(
  companyId: string,
  heads: readonly { key: string; label: string; accountCode: string }[],
  from: Date,
  to: Date,
) {
  const codes = heads.map((h) => h.accountCode)
  const accounts = await prisma.account.findMany({
    where: { companyId, code: { in: codes } }, select: { id: true, code: true },
  })
  const byCode = new Map(accounts.map((a) => [a.code, a.id]))
  const ids = accounts.map((a) => a.id)

  const [openingRows, periodRows] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { accountId: { in: ids }, journalEntry: { companyId, date: { lt: from } } },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { accountId: { in: ids }, journalEntry: { companyId, date: { gte: from, lte: to } } },
      _sum: { debit: true, credit: true },
    }),
  ])
  const o = new Map(openingRows.map((r) => [r.accountId, r._sum]))
  const p = new Map(periodRows.map((r) => [r.accountId, r._sum]))
  const n = (v: unknown) => new Decimal(v?.toString() ?? '0')

  return heads.map((h) => {
    const id = byCode.get(h.accountCode)
    const os = id ? o.get(id) : undefined
    const ps = id ? p.get(id) : undefined
    // both are asset accounts: a debit is money in, a credit is money out
    const opening = n(os?.debit).minus(n(os?.credit))
    const credited = n(ps?.debit)
    const debited = n(ps?.credit)
    return {
      key: h.key, label: h.label, accountCode: h.accountCode,
      opening, credited, debited, closing: opening.plus(credited).minus(debited),
    }
  })
}

async function statementLines(
  companyId: string,
  heads: readonly { key: string; label: string; accountCode: string }[],
  from: Date,
  to: Date,
  opening: Decimal,
): Promise<LedgerStatementLine[]> {
  const codes = heads.map((h) => h.accountCode)
  const rows = await prisma.journalLine.findMany({
    where: {
      account: { companyId, code: { in: codes } },
      journalEntry: { companyId, date: { gte: from, lte: to } },
    },
    include: {
      account: { select: { code: true } },
      journalEntry: { select: { entryNo: true, date: true, narration: true, sourceType: true } },
    },
    orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntry: { entryNo: 'asc' } }],
  })

  const labelOf = new Map(heads.map((h) => [h.accountCode, h.label]))
  let running = opening
  return rows.map((l) => {
    const credited = new Decimal(l.debit.toString())
    const debited = new Decimal(l.credit.toString())
    running = running.plus(credited).minus(debited)
    return {
      date: l.journalEntry.date,
      entryNo: l.journalEntry.entryNo,
      narration: l.journalEntry.narration,
      head: labelOf.get(l.account.code) ?? l.account.code,
      sourceType: l.journalEntry.sourceType,
      credited, debited, balance: running,
    }
  })
}

const totalOf = (heads: LedgerHead[]) => ({
  opening: heads.reduce((a, h) => a.plus(h.opening), ZERO as Decimal),
  credited: heads.reduce((a, h) => a.plus(h.credited), ZERO as Decimal),
  debited: heads.reduce((a, h) => a.plus(h.debited), ZERO as Decimal),
  closing: heads.reduce((a, h) => a.plus(h.closing), ZERO as Decimal),
})

export async function electronicLedgers(
  ctx: RequestContext, period: { from: Date; to: Date },
): Promise<{ cash: ElectronicLedger; credit: ElectronicLedger }> {
  assertCan(ctx.role, 'tax', 'read')

  const [cashHeads, creditHeads] = await Promise.all([
    headBalances(ctx.companyId, CASH_HEADS, period.from, period.to),
    headBalances(ctx.companyId, CREDIT_HEADS, period.from, period.to),
  ])
  const cashTotal = totalOf(cashHeads)
  const creditTotal = totalOf(creditHeads)
  const [cashLines, creditLines] = await Promise.all([
    statementLines(ctx.companyId, CASH_HEADS, period.from, period.to, cashTotal.opening),
    statementLines(ctx.companyId, CREDIT_HEADS, period.from, period.to, creditTotal.opening),
  ])

  const cashNotes: string[] = [
    'A challan credits this ledger; a set-off debits it. Until it is debited nothing has been paid — ' +
    'under rule 88B(1) interest runs to the date of debit, not to the date the money arrived.',
  ]
  const idle = cashHeads.filter((h) => h.key !== 'other' && h.closing.gt(0))
  if (idle.length > 1) {
    cashNotes.push(
      'Balances under different major heads cannot be used for one another — moving them needs Form PMT-09.',
    )
  }
  if (cashTotal.closing.gt(0)) {
    cashNotes.push(
      `${formatINR(cashTotal.closing)} is lying in the cash ledger. It is an asset, and refundable under ` +
      's.54(1) — but it earns nothing and discharges nothing until a return is offset against it.',
    )
  }

  const creditNotes: string[] = [
    'Input credit accrues here as bills and expenses post, and is consumed head-wise by a set-off. ' +
    'It may be used for TAX only — never for interest, fee or penalty.',
  ]
  const cgst = creditHeads.find((h) => h.key === 'cgst')!
  const sgst = creditHeads.find((h) => h.key === 'sgst')!
  if (cgst.closing.gt(0) || sgst.closing.gt(0)) {
    creditNotes.push(
      'CGST credit can never discharge SGST, nor SGST discharge CGST (s.49(5)(e) and (f)) — ' +
      'so these two balances are not interchangeable however similar they look.',
    )
  }

  return {
    cash: { kind: 'CASH', title: 'Electronic cash ledger', heads: cashHeads, total: cashTotal, lines: cashLines, notes: cashNotes },
    credit: { kind: 'CREDIT', title: 'Electronic credit ledger', heads: creditHeads, total: creditTotal, lines: creditLines, notes: creditNotes },
  }
}

/**
 * Credit ledger balance as at a date, head-wise.
 *
 * Cumulative, not period-restricted — unused credit carries forward indefinitely, and the
 * portal's ledger is a running balance. The RCM input credit merges into IGST because that
 * is what it is: the split exists in our chart of accounts, not in the law.
 */
export async function creditLedgerBalance(companyId: string, on: Date): Promise<CreditHeads> {
  const heads = await headBalances(companyId, CREDIT_HEADS, new Date(0), on)
  const at = (k: string) => heads.find((h) => h.key === k)!.closing
  return {
    igst: round2(Decimal.max(at('igst').plus(at('igstRcm')), ZERO)),
    cgst: round2(Decimal.max(at('cgst'), ZERO)),
    sgst: round2(Decimal.max(at('sgst'), ZERO)),
  }
}

/** Cash ledger balance as at a date, head-wise. */
export async function cashLedgerBalance(companyId: string, on: Date): Promise<CashHeads> {
  const heads = await headBalances(companyId, CASH_HEADS, new Date(0), on)
  const at = (k: string) => round2(Decimal.max(heads.find((h) => h.key === k)!.closing, ZERO))
  return { igst: at('igst'), cgst: at('cgst'), sgst: at('sgst'), other: at('other') }
}
