import { Decimal, ZERO } from '@/lib/money'
import type { Posting } from '../types'

export interface InvoicePostingDoc {
  number: string
  customerId: string
  projectId?: string | null
  grandTotal: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  roundOff: Decimal
  /** revenue split by income account code, e.g. { '4020': 70000, '4030': 15000 } */
  revenueByAccount: Record<string, Decimal>
}

export const ACCOUNTS = {
  AR: '1100',
  BANK: '1010',
  OUTPUT_CGST: '2110',
  OUTPUT_SGST: '2120',
  OUTPUT_IGST: '2130',
  ROUND_OFF_GAIN: '4900',
  ROUND_OFF_LOSS: '5500',
  TDS_REC: { '194J': '1310', '194C': '1320' } as Record<string, string>,
} as const

/**
 * docs/12 §2.1–2.3. Pure — no I/O, so it is property-testable.
 *
 * 🔴 No TDS entry here. TDS is recognised on RECEIPT, because the customer may not
 * deduct at all. Booking it at invoice time would overstate the asset.
 */
export function postInvoice(doc: InvoicePostingDoc): Posting[] {
  const postings: Posting[] = []
  const dim = { customerId: doc.customerId, projectId: doc.projectId ?? undefined }

  postings.push({ accountCode: ACCOUNTS.AR, debit: doc.grandTotal, narration: `Invoice ${doc.number}`, ...dim })

  for (const [code, amount] of Object.entries(doc.revenueByAccount)) {
    if (amount.isZero()) continue
    postings.push({ accountCode: code, credit: amount, ...dim })
  }

  if (doc.cgst.gt(0)) postings.push({ accountCode: ACCOUNTS.OUTPUT_CGST, credit: doc.cgst, ...dim })
  if (doc.sgst.gt(0)) postings.push({ accountCode: ACCOUNTS.OUTPUT_SGST, credit: doc.sgst, ...dim })
  if (doc.igst.gt(0)) postings.push({ accountCode: ACCOUNTS.OUTPUT_IGST, credit: doc.igst, ...dim })

  // Round-off goes to its own line so the trial balance never carries a silent residue.
  if (doc.roundOff.gt(0)) postings.push({ accountCode: ACCOUNTS.ROUND_OFF_GAIN, credit: doc.roundOff, narration: 'Round off', ...dim })
  else if (doc.roundOff.lt(0)) postings.push({ accountCode: ACCOUNTS.ROUND_OFF_LOSS, debit: doc.roundOff.abs(), narration: 'Round off', ...dim })

  return postings
}

export interface ReceiptPostingDoc {
  number: string
  customerId: string
  projectId?: string | null
  /** cash actually received */
  amount: Decimal
  /** TDS the customer deducted, by section */
  tdsAmount: Decimal
  tdsSection: string | null
  bankCharge: Decimal
  fxGainLoss: Decimal
  bankAccountCode: string
}

/**
 * docs/12 §2.4. The customer paid ₹91,800 against a ₹1,00,300 invoice and kept ₹8,500
 * as TDS, so AR clears by the full invoice value while only the cash hits the bank.
 */
export function postReceipt(doc: ReceiptPostingDoc): Posting[] {
  const postings: Posting[] = []
  const dim = { customerId: doc.customerId, projectId: doc.projectId ?? undefined }

  postings.push({ accountCode: doc.bankAccountCode, debit: doc.amount, narration: `Receipt ${doc.number}`, ...dim })

  if (doc.tdsAmount.gt(0)) {
    const account = (doc.tdsSection && ACCOUNTS.TDS_REC[doc.tdsSection]) ?? ACCOUNTS.TDS_REC['194J']
    postings.push({ accountCode: account, debit: doc.tdsAmount, narration: `TDS u/s ${doc.tdsSection}`, ...dim })
  }

  // Inward remittances arrive net of bank/intermediary charges — common on exports.
  if (doc.bankCharge.gt(0)) postings.push({ accountCode: '5600', debit: doc.bankCharge, narration: 'Bank charges on receipt', ...dim })
  if (doc.fxGainLoss.gt(0)) postings.push({ accountCode: '4920', credit: doc.fxGainLoss, narration: 'Forex gain', ...dim })
  else if (doc.fxGainLoss.lt(0)) postings.push({ accountCode: '5900', debit: doc.fxGainLoss.abs(), narration: 'Forex loss', ...dim })

  const arCleared = doc.amount
    .plus(doc.tdsAmount)
    .plus(doc.bankCharge)
    .minus(doc.fxGainLoss.gt(0) ? doc.fxGainLoss : ZERO)
    .plus(doc.fxGainLoss.lt(0) ? doc.fxGainLoss.abs() : ZERO)

  postings.push({ accountCode: ACCOUNTS.AR, credit: arCleared, ...dim })
  return postings
}

/** Mirror of postInvoice, for cancellation. */
export function postInvoiceReversal(doc: InvoicePostingDoc): Posting[] {
  return postInvoice(doc).map((p) => ({ ...p, debit: p.credit, credit: p.debit }))
}

export function revenueFromLines(
  lines: { taxableValue: Decimal; incomeAccountCode?: string | null }[],
  fallback = '4010',
): Record<string, Decimal> {
  const out: Record<string, Decimal> = {}
  for (const l of lines) {
    const code = l.incomeAccountCode ?? fallback
    out[code] = (out[code] ?? new Decimal(0)).plus(l.taxableValue)
  }
  return out
}
