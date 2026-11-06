import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { createReceipt } from '@/server/services/sales/receipt'
import { payBill } from '@/server/services/purchases/bill'
import { postJournal } from '@/server/services/accounting/journal'
import { assertPostable } from '@/server/services/accounting/period'
import { suggestMatches, type BankTxnFacts, type OpenInvoice, type OpenBill, type LearnedRule, type Suggestion } from './match'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import { noteTotals } from '@/server/services/invoicing/notes'

export interface TxnWithSuggestions {
  txn: {
    id: string; amount: Decimal; direction: 'DEBIT' | 'CREDIT'; valueDate: Date
    rawNarration: string; utr: string | null; counterparty: string | null; status: string
  }
  suggestions: Suggestion[]
}

/** Load everything the matcher needs, once, for a whole batch. */
async function loadCandidates(companyId: string) {
  const [invoices, bills, rules] = await Promise.all([
    prisma.invoice.findMany({
      // 🔴 docs/91 — rupee invoices only. A bank line is in rupees and a foreign invoice is in
      // its own currency, so comparing 21,000 against 250 offered nonsense matches; a foreign
      // payment is recorded as a receipt with the rupees credited typed in.
      where: { companyId, currency: 'INR', status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] } },
      include: { customer: { select: { id: true, name: true, aliases: true } } },
    }),
    prisma.vendorBill.findMany({
      where: { companyId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
      include: { vendor: { select: { id: true, name: true, aliases: true } } },
    }),
    prisma.bankRule.findMany({ where: { companyId } }),
  ])

  // 🔴 docs/86 — net of credit notes. An invoice credited down to ₹94,400 was still offered
  // at ₹1,18,000, so the payment that actually arrived read as a part payment and the invoice
  // could never be closed from the bank screen.
  const notes = await noteTotals(companyId, invoices.map((i) => i.id))

  const openInvoices: OpenInvoice[] = invoices.map((i) => {
    const open = invoiceOpen(i, notes.get(i.id) ?? NO_NOTES)
    return {
      id: i.id, number: i.number, customerId: i.customerId,
      customerName: i.customer.name, customerAliases: i.customer.aliases,
      outstanding: open.outstanding,
      tdsExpected: open.tdsExpected,
      tdsSection: i.tdsSection, date: i.date,
      knownUtr: null,
      isExport: i.taxMode === 'EXPORT',
    }
  })

  const openBills: OpenBill[] = bills.map((b) => ({
    id: b.id, billNumber: b.billNumber, vendorId: b.vendorId,
    vendorName: b.vendor.name, vendorAliases: b.vendor.aliases,
    outstanding: new Decimal(b.grandTotal.toString()).minus(b.tdsAmount.toString()).minus(b.amountPaid.toString()),
    dueDate: b.dueDate,
  }))

  const learned: LearnedRule[] = rules.map((r) => ({
    id: r.id, pattern: r.pattern, matchType: r.matchType,
    direction: r.direction, accountCode: r.accountCode, customerId: r.customerId,
    vendorId: r.vendorId, employeeId: r.employeeId, autoApply: r.autoApply,
    label: r.label ?? r.pattern,
  }))

  return { openInvoices, openBills, learned }
}

export async function reconciliationQueue(ctx: RequestContext, bankAccountId?: string): Promise<TxnWithSuggestions[]> {
  assertCan(ctx.role, 'banking', 'read')

  const txns = await prisma.bankTransaction.findMany({
    where: { companyId: ctx.companyId, status: { in: ['UNMATCHED', 'SUGGESTED'] }, ...(bankAccountId ? { bankAccountId } : {}) },
    orderBy: { valueDate: 'asc' },
    take: 200,
  })
  if (txns.length === 0) return []

  const { openInvoices, openBills, learned } = await loadCandidates(ctx.companyId)
  const facts: BankTxnFacts[] = txns.map((t) => ({
    id: t.id, amount: new Decimal(t.amount.toString()), direction: t.direction,
    valueDate: t.valueDate, rawNarration: t.rawNarration, utr: t.utr,
    counterparty: t.counterpartyGuess, remark: null,
  }))

  return facts.map((f, i) => ({
    txn: {
      id: f.id, amount: f.amount, direction: f.direction, valueDate: f.valueDate,
      rawNarration: f.rawNarration, utr: f.utr, counterparty: f.counterparty, status: txns[i].status,
    },
    suggestions: suggestMatches({ txn: f, invoices: openInvoices, bills: openBills, rules: learned, siblings: facts }),
  }))
}

/**
 * Accept a suggestion. This is where a bank line becomes an accounting entry — so it
 * goes through the same services everything else does, rather than writing the ledger
 * directly. A receipt booked from the bank is identical to one keyed by hand.
 */
export async function applyMatch(ctx: RequestContext, txnId: string, suggestion: Suggestion, opts: { learn?: boolean } = {}) {
  assertCan(ctx.role, 'banking.post', 'approve')

  const txn = await prisma.bankTransaction.findFirst({ where: { id: txnId, companyId: ctx.companyId } })
  if (!txn) throw new NotFound('Bank transaction not found')
  if (txn.status === 'MATCHED') throw new AppError('That line is already matched')
  const date = txn.valueDate.toISOString().slice(0, 10)
  await assertPostable(ctx.companyId, txn.valueDate)

  const s = suggestion.suggestion

  if (s.kind === 'RECEIPT') {
    const receipt = await createReceipt(ctx, {
      customerId: s.customerId, date, mode: 'NEFT', reference: txn.utr ?? undefined,
      bankAccountId: txn.bankAccountId,
      bankCharge: s.bankCharge.gt(0) ? s.bankCharge.toFixed(2) : undefined,
      allocations: s.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed(2), tdsAmount: a.tds.toFixed(2) })),
    })
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { status: 'MATCHED', receiptId: receipt.id, confidence: suggestion.confidence.toString(), matchReason: suggestion.reason },
    })
  } else if (s.kind === 'BILL_PAYMENT') {
    const payment = await payBill(ctx, { billId: s.billId, date, amount: s.amount.toFixed(2), mode: 'NEFT', reference: txn.utr ?? undefined, bankAccountId: txn.bankAccountId })
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { status: 'MATCHED', billPaymentId: payment.id, confidence: suggestion.confidence.toString(), matchReason: suggestion.reason },
    })
  } else if (s.kind === 'LEDGER') {
    const bank = await prisma.companyBankAccount.findFirstOrThrow({ where: { id: txn.bankAccountId }, include: { ledgerAccount: true } })
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)
    const amount = new Decimal(txn.amount.toString())
    const entry = await postJournal(ctx, {
      date: txn.valueDate, narration: `${s.label} — ${txn.rawNarration.slice(0, 80)}`,
      sourceType: 'BANK_TXN', sourceId: txn.id,
      postings: txn.direction === 'DEBIT'
        ? [{ accountCode: s.accountCode, debit: amount, customerId: s.customerId, vendorId: s.vendorId, employeeId: s.employeeId },
           { accountCode: bank.ledgerAccount.code, credit: amount }]
        : [{ accountCode: bank.ledgerAccount.code, debit: amount },
           { accountCode: s.accountCode, credit: amount, customerId: s.customerId, vendorId: s.vendorId, employeeId: s.employeeId }],
    })
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { status: 'MATCHED', journalEntryId: entry.id, confidence: suggestion.confidence.toString(), matchReason: suggestion.reason },
    })
  } else if (s.kind === 'CONTRA') {
    await prisma.bankTransaction.updateMany({
      where: { id: { in: [txn.id, s.pairedTxnId] }, companyId: ctx.companyId },
      data: { status: 'EXCLUDED', matchReason: 'Contra — transfer between own accounts' },
    })
  }

  if (opts.learn) await learnFrom(ctx, txn.rawNarration, txn.direction, suggestion)
  await audit(ctx, { entity: 'BankTransaction', entityId: txn.id, action: 'POST', after: { tier: suggestion.tier, reason: suggestion.reason } })
}

/**
 * docs/02 §A3 — the learning loop.
 *
 * Every confirmed match writes a rule candidate keyed on the narration's stable part.
 * After two confirmations it auto-applies. This is what turns a 60%-match system into a
 * 90%-match one by month three, without anybody configuring anything.
 */
export async function learnFrom(ctx: RequestContext, narration: string, direction: 'DEBIT' | 'CREDIT', suggestion: Suggestion) {
  const s = suggestion.suggestion
  // the stable part of a narration is the party, not the reference numbers
  const pattern = narrationSignature(narration)
  if (!pattern || pattern.length < 4) return

  const existing = await prisma.bankRule.findFirst({ where: { companyId: ctx.companyId, pattern, direction } })
  const data = {
    customerId: s.kind === 'RECEIPT' ? s.customerId : s.kind === 'LEDGER' ? s.customerId ?? null : null,
    vendorId: s.kind === 'BILL_PAYMENT' ? s.vendorId : s.kind === 'LEDGER' ? s.vendorId ?? null : null,
    employeeId: s.kind === 'LEDGER' ? s.employeeId ?? null : null,
    accountCode: s.kind === 'LEDGER' ? s.accountCode : null,
    label: s.kind === 'LEDGER' ? s.label : null,
  }

  if (existing) {
    const count = existing.confirmCount + 1
    await prisma.bankRule.update({
      where: { id: existing.id },
      data: { ...data, confirmCount: count, autoApply: count >= 2 },
    })
  } else {
    await prisma.bankRule.create({
      data: { companyId: ctx.companyId, pattern, matchType: 'CONTAINS', direction, confirmCount: 1, autoApply: false, ...data },
    })
  }
}

/** Strip the volatile parts — reference numbers, dates, amounts — leaving the party. */
export function narrationSignature(narration: string): string {
  const parts = narration.split('/').map((p) => p.trim()).filter(Boolean)
  const stable = parts.find((p) => /[A-Za-z]{4,}/.test(p) && !/^\d+$/.test(p) && !/^[A-Z]{4,6}\d{6,}$/.test(p)
    && !/^(NEFT|RTGS|IMPS|INB|MOB|P2A|TPARTY|UPI)$/i.test(p))
  return (stable ?? narration).replace(/\d{6,}/g, '').replace(/\s+/g, ' ').trim().slice(0, 48)
}

/** The bank reconciliation statement — docs/02 §A5. */
export async function bankReconciliationStatement(ctx: RequestContext, bankAccountId: string, asOf = new Date()) {
  assertCan(ctx.role, 'banking', 'read')

  const bank = await prisma.companyBankAccount.findFirstOrThrow({
    where: { id: bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true },
  })
  if (!bank.ledgerAccount) throw new AppError(`${bank.label} is not mapped to a ledger account`)

  const ledger = await prisma.journalLine.aggregate({
    where: { accountId: bank.ledgerAccountId!, journalEntry: { companyId: ctx.companyId, date: { lte: asOf } } },
    _sum: { debit: true, credit: true },
  })
  const bookBalance = new Decimal(ledger._sum.debit?.toString() ?? 0).minus(ledger._sum.credit?.toString() ?? 0)

  const lastImport = await prisma.bankStatementImport.findFirst({
    where: { companyId: ctx.companyId, bankAccountId }, orderBy: { periodTo: 'desc' },
  })
  const statementBalance = lastImport ? new Decimal(lastImport.closingBalance.toString()) : null

  const unmatched = await prisma.bankTransaction.findMany({
    where: { companyId: ctx.companyId, bankAccountId, status: { in: ['UNMATCHED', 'SUGGESTED', 'PART_MATCHED'] } },
  })
  const unmatchedCredits = unmatched.filter((t) => t.direction === 'CREDIT').reduce((a, t) => a.plus(t.amount.toString()), ZERO)
  const unmatchedDebits = unmatched.filter((t) => t.direction === 'DEBIT').reduce((a, t) => a.plus(t.amount.toString()), ZERO)

  // books + what the bank shows that we have not yet booked = the statement
  const reconciled = bookBalance.plus(unmatchedCredits).minus(unmatchedDebits)
  const difference = statementBalance ? reconciled.minus(statementBalance) : null

  return {
    bankLabel: bank.label,
    asOf,
    bookBalance,
    statementBalance,
    unmatchedCount: unmatched.length,
    unmatchedCredits,
    unmatchedDebits,
    reconciled,
    difference,
    agrees: difference ? difference.abs().lte('0.01') : false,
    lastImportTo: lastImport?.periodTo ?? null,
  }
}
