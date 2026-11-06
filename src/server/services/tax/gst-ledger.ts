import { prisma } from '@/server/db'
import { inrOf } from '@/lib/fx'
import { Decimal, ZERO } from '@/lib/money'

/**
 * The GST position is read from the GENERAL LEDGER, not from invoices.
 *
 * That matters: input GST arrives from vendor bills and expenses (phase 3), RCM from
 * self-invoices, and credit notes reverse output tax. Summing invoices would miss all
 * of it. Reading the journal means every source is counted the moment it posts, and the
 * GST screen can never disagree with the trial balance.
 */

export const GST_ACCOUNTS = {
  outputCgst: '2110', outputSgst: '2120', outputIgst: '2130', rcmPayable: '2140',
  inputCgst: '1210', inputSgst: '1220', inputIgst: '1230', rcmItc: '1240',
} as const

/**
 * The electronic cash ledger, head-wise — docs/46.
 *
 * 🔴 One account per major head, because cash under one head cannot pay another without
 * Form PMT-09. A single "GST paid in advance" account would balance perfectly and still
 * tell a filer they could pay an SGST liability with money sitting under CGST.
 *
 * `other` is the minor head that carries interest, late fee and penalty — amounts the
 * credit ledger may never be used for.
 */
export const CASH_LEDGER_ACCOUNTS = {
  igst: '1251', cgst: '1252', sgst: '1253', other: '1254',
} as const

export interface GstPosition {
  output: { cgst: Decimal; sgst: Decimal; igst: Decimal; total: Decimal }
  input: { cgst: Decimal; sgst: Decimal; igst: Decimal; total: Decimal }
  rcm: { payable: Decimal; itc: Decimal }
  /** output − input. Positive means payable in cash. */
  net: Decimal
  /** RCM must be paid in cash and cannot be set off against existing ITC. */
  cashPayable: Decimal
}

/**
 * 🔴 Settling a period is dated in a LATER period, so settlements are excluded here.
 *
 * A Q1 return is paid and offset in July, which falls inside Q2. Counting those postings as
 * Q2 movement made Q2's output tax read 4,500 instead of 9,000 — the return under-reported
 * the quarter's own supplies by exactly what the previous quarter had just settled, and the
 * figure moved every time a payment was recorded. Found by docs/46; the same flaw was there
 * from docs/45, because a payment debited these accounts directly.
 *
 * What a return reports is the tax on the supplies and credit OF THAT PERIOD. The account's
 * true balance still lives in the trial balance, where it belongs.
 */
const SETTLEMENT_SOURCES = ['GST_PAYMENT', 'GST_SET_OFF'] as const

/** Net movement on an account over a window. Credits positive for liabilities, debits positive for assets. */
async function movement(companyId: string, code: string, from: Date, to: Date, side: 'debit' | 'credit') {
  const rows = await prisma.journalLine.aggregate({
    where: {
      account: { companyId, code },
      journalEntry: {
        companyId, date: { gte: from, lte: to },
        sourceType: { notIn: [...SETTLEMENT_SOURCES] },
      },
    },
    _sum: { debit: true, credit: true },
  })
  const d = new Decimal(rows._sum.debit?.toString() ?? 0)
  const c = new Decimal(rows._sum.credit?.toString() ?? 0)
  return side === 'credit' ? c.minus(d) : d.minus(c)
}

export async function gstPosition(companyId: string, from: Date, to: Date): Promise<GstPosition> {
  const [oc, os, oi, rp, ic, is, ii, ri] = await Promise.all([
    movement(companyId, GST_ACCOUNTS.outputCgst, from, to, 'credit'),
    movement(companyId, GST_ACCOUNTS.outputSgst, from, to, 'credit'),
    movement(companyId, GST_ACCOUNTS.outputIgst, from, to, 'credit'),
    movement(companyId, GST_ACCOUNTS.rcmPayable, from, to, 'credit'),
    movement(companyId, GST_ACCOUNTS.inputCgst, from, to, 'debit'),
    movement(companyId, GST_ACCOUNTS.inputSgst, from, to, 'debit'),
    movement(companyId, GST_ACCOUNTS.inputIgst, from, to, 'debit'),
    movement(companyId, GST_ACCOUNTS.rcmItc, from, to, 'debit'),
  ])

  const outputTotal = oc.plus(os).plus(oi)
  const inputTotal = ic.plus(is).plus(ii).plus(ri)

  return {
    output: { cgst: oc, sgst: os, igst: oi, total: outputTotal },
    input: { cgst: ic, sgst: is, igst: ii, total: inputTotal },
    rcm: { payable: rp, itc: ri },
    net: outputTotal.minus(inputTotal),
    cashPayable: rp,
  }
}

/** Taxable turnover split by how it was taxed — the top of GSTR-3B table 3.1. */
export async function outwardSupplies(companyId: string, from: Date, to: Date) {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId, date: { gte: from, lte: to },
      status: { notIn: ['DRAFT', 'CANCELLED'] },
    },
    select: { taxMode: true, currency: true, fxRate: true, taxableValue: true, cgst: true, sgst: true, igst: true, customer: { select: { gstin: true } } },
  })

  const bucket = () => ({ taxable: ZERO as Decimal, cgst: ZERO as Decimal, sgst: ZERO as Decimal, igst: ZERO as Decimal, count: 0 })
  const out = { taxable: bucket(), zeroRated: bucket(), exempt: bucket() }

  for (const i of invoices) {
    const target = i.taxMode === 'EXPORT' || i.taxMode === 'SEZ_WITHOUT_PAY' ? out.zeroRated : out.taxable
    // docs/91 — GSTR-3B 3.1 is in rupees; an export invoice's value is converted at its own rate
    // (rule 34 asks for the notified rate at the time of supply — a CA question, see docs/91)
    target.taxable = target.taxable.plus(inrOf(i, i.taxableValue.toString()))
    target.cgst = target.cgst.plus(inrOf(i, i.cgst.toString()))
    target.sgst = target.sgst.plus(inrOf(i, i.sgst.toString()))
    target.igst = target.igst.plus(inrOf(i, i.igst.toString()))
    target.count += 1
  }
  return out
}
