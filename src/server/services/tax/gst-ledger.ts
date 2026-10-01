import { prisma } from '@/server/db'
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

export interface GstPosition {
  output: { cgst: Decimal; sgst: Decimal; igst: Decimal; total: Decimal }
  input: { cgst: Decimal; sgst: Decimal; igst: Decimal; total: Decimal }
  rcm: { payable: Decimal; itc: Decimal }
  /** output − input. Positive means payable in cash. */
  net: Decimal
  /** RCM must be paid in cash and cannot be set off against existing ITC. */
  cashPayable: Decimal
}

/** Net movement on an account over a window. Credits positive for liabilities, debits positive for assets. */
async function movement(companyId: string, code: string, from: Date, to: Date, side: 'debit' | 'credit') {
  const rows = await prisma.journalLine.aggregate({
    where: {
      account: { companyId, code },
      journalEntry: { companyId, date: { gte: from, lte: to } },
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
    select: { taxMode: true, taxableValue: true, cgst: true, sgst: true, igst: true, customer: { select: { gstin: true } } },
  })

  const bucket = () => ({ taxable: ZERO as Decimal, cgst: ZERO as Decimal, sgst: ZERO as Decimal, igst: ZERO as Decimal, count: 0 })
  const out = { taxable: bucket(), zeroRated: bucket(), exempt: bucket() }

  for (const i of invoices) {
    const target = i.taxMode === 'EXPORT' || i.taxMode === 'SEZ_WITHOUT_PAY' ? out.zeroRated : out.taxable
    target.taxable = target.taxable.plus(i.taxableValue.toString())
    target.cgst = target.cgst.plus(i.cgst.toString())
    target.sgst = target.sgst.plus(i.sgst.toString())
    target.igst = target.igst.plus(i.igst.toString())
    target.count += 1
  }
  return out
}
