import { Decimal, ZERO } from '@/lib/money'
import type { Posting } from '../types'

export const AP = '2000'
export const BANK = '1010'

export const INPUT_GST = { cgst: '1210', sgst: '1220', igst: '1230', rcm: '1240' } as const
export const RCM_PAYABLE = '2140'

/**
 * TDS payable account per section.
 *
 * The chart has four TDS liability accounts — 192 salary, 194J, 194C and 195 non-resident
 * — so the other resident sections fold into 2220. That is deliberate: they are all
 * deposited on the same challan against the same TAN, and the SECTION, not the account, is
 * what the 26Q return reports. Splitting them into their own GL accounts would add rows to
 * the balance sheet that nobody reconciles separately.
 */
export const TDS_PAYABLE: Record<string, string> = {
  '192': '2210',
  '194J': '2220', '194J-TS': '2220', '194J-DIR': '2220',
  '194C': '2230',
  '194H': '2220', '194I-A': '2220', '194I-B': '2220', '194A': '2220', '194Q': '2220',
  '195': '2240',
}
export const tdsPayableAccount = (section: string) => TDS_PAYABLE[section] ?? '2220'

export interface VendorBillDoc {
  billNumber: string
  vendorId: string
  projectId?: string | null
  /** expense account code → amount, so one bill can split across accounts */
  costByAccount: Record<string, Decimal>
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  grandTotal: Decimal
  /** true when the GST is not claimable — s.17(5) or an unregistered supplier */
  itcEligible: boolean
}

/**
 * docs/12 §2.5. Input GST is debited to the ITC accounts only when it is claimable;
 * when s.17(5) blocks it, the tax is part of the cost and must not sit in 1210/1220
 * pretending to be recoverable.
 */
export function postVendorBill(doc: VendorBillDoc): Posting[] {
  const postings: Posting[] = []
  const dim = { vendorId: doc.vendorId, projectId: doc.projectId ?? undefined }
  const gst = doc.cgst.plus(doc.sgst).plus(doc.igst)

  const costEntries = Object.entries(doc.costByAccount).filter(([, v]) => !v.isZero())
  if (doc.itcEligible || gst.isZero()) {
    for (const [code, amount] of costEntries) postings.push({ accountCode: code, debit: amount, narration: `Bill ${doc.billNumber}`, ...dim })
    if (doc.cgst.gt(0)) postings.push({ accountCode: INPUT_GST.cgst, debit: doc.cgst, ...dim })
    if (doc.sgst.gt(0)) postings.push({ accountCode: INPUT_GST.sgst, debit: doc.sgst, ...dim })
    if (doc.igst.gt(0)) postings.push({ accountCode: INPUT_GST.igst, debit: doc.igst, ...dim })
  } else {
    // blocked credit — the tax lands in the expense, proportionally across the split
    const base = costEntries.reduce((a, [, v]) => a.plus(v), ZERO)
    let allocated = ZERO
    costEntries.forEach(([code, amount], i) => {
      const share = i === costEntries.length - 1
        ? gst.minus(allocated)
        : gst.mul(amount).div(base).toDecimalPlaces(2)
      allocated = allocated.plus(share)
      postings.push({ accountCode: code, debit: amount.plus(share), narration: `Bill ${doc.billNumber} (GST blocked u/s 17(5))`, ...dim })
    })
  }

  postings.push({ accountCode: AP, credit: doc.grandTotal, ...dim })
  return postings
}

/** docs/12 §2.5 — a separate entry, so the deduction is visible rather than netted into the bill. */
export function postTdsDeduction(doc: { billNumber: string; vendorId: string; sectionCode: string; tdsAmount: Decimal }): Posting[] {
  return [
    { accountCode: AP, debit: doc.tdsAmount, narration: `TDS u/s ${doc.sectionCode} on ${doc.billNumber}`, vendorId: doc.vendorId },
    { accountCode: tdsPayableAccount(doc.sectionCode), credit: doc.tdsAmount, vendorId: doc.vendorId },
  ]
}

/**
 * docs/12 §2.6 — reverse charge on an import of service.
 *
 * Two halves that cancel: the liability (2140) is paid in CASH and can never be set off
 * against existing ITC, while the credit (1240) is claimable in the same GSTR-3B. Net
 * cost to the business is nil — provided it is actually done.
 */
export function postRcmSelfInvoice(doc: { selfInvoiceNo: string; vendorId: string; rcmIgst: Decimal }): Posting[] {
  return [
    { accountCode: INPUT_GST.rcm, debit: doc.rcmIgst, narration: `RCM self-invoice ${doc.selfInvoiceNo}`, vendorId: doc.vendorId },
    { accountCode: RCM_PAYABLE, credit: doc.rcmIgst, vendorId: doc.vendorId },
  ]
}

export function postBillPayment(doc: {
  billNumber: string; vendorId: string; amount: Decimal; bankAccountCode: string
}): Posting[] {
  return [
    { accountCode: AP, debit: doc.amount, narration: `Payment against ${doc.billNumber}`, vendorId: doc.vendorId },
    { accountCode: doc.bankAccountCode, credit: doc.amount, vendorId: doc.vendorId },
  ]
}

export interface ExpenseDoc {
  description: string
  accountCode: string
  projectId?: string | null
  vendorId?: string | null
  employeeId?: string | null
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  total: Decimal
  itcEligible: boolean
  /** BANK | CASH | CARD settle immediately; PERSONAL_REIMBURSABLE creates a payable */
  paidFrom: 'BANK' | 'CASH' | 'CARD' | 'PERSONAL_REIMBURSABLE'
  bankAccountCode: string
}

export function postExpense(doc: ExpenseDoc): Posting[] {
  const postings: Posting[] = []
  const dim = { projectId: doc.projectId ?? undefined, vendorId: doc.vendorId ?? undefined, employeeId: doc.employeeId ?? undefined }
  const gst = doc.cgst.plus(doc.sgst).plus(doc.igst)

  if (doc.itcEligible && gst.gt(0)) {
    postings.push({ accountCode: doc.accountCode, debit: doc.taxableValue, narration: doc.description, ...dim })
    if (doc.cgst.gt(0)) postings.push({ accountCode: INPUT_GST.cgst, debit: doc.cgst, ...dim })
    if (doc.sgst.gt(0)) postings.push({ accountCode: INPUT_GST.sgst, debit: doc.sgst, ...dim })
    if (doc.igst.gt(0)) postings.push({ accountCode: INPUT_GST.igst, debit: doc.igst, ...dim })
  } else {
    postings.push({ accountCode: doc.accountCode, debit: doc.total, narration: doc.description, ...dim })
  }

  const credit = doc.paidFrom === 'PERSONAL_REIMBURSABLE' ? AP
    : doc.paidFrom === 'CASH' ? '1050'
    : doc.bankAccountCode
  postings.push({ accountCode: credit, credit: doc.total, ...dim })
  return postings
}
