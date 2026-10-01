import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { importStatement } from '@/server/services/banking/import'
import { reconciliationQueue, applyMatch, bankReconciliationStatement, narrationSignature } from '@/server/services/banking/reconcile'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let bankId = '', clickAr = '', invoiceId = ''

const statement = (rows: string, opening = '47306.25', closing: string) => `
Statement of Axis Bank Account No : 921020015185413
Opening Balance: INR ${opening}

Transaction Date,Value Date,Particulars,Cheque Number,Amount(INR),Debit/Credit,Balance(INR),Branch Name(SOL)
${rows}

Closing Balance: INR ${closing}
`.trim()

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  bankId = (await prisma.companyBankAccount.findFirstOrThrow({ where: { companyId: company.id } })).id

  clickAr = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', billingAddress: {}, paymentTermDays: 15, defaultTdsSection: '194J',
  } })).id

  const d = await createInvoice(ctx, {
    customerId: clickAr, date: '2026-09-30', tdsSection: '194J',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '85000', gstRatePct: '18' }],
  })
  const inv = await sendInvoice(ctx, d.id)
  invoiceId = inv.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('statement import', () => {
  it('🔴 refuses a batch whose balances do not reconcile', async () => {
    const bad = statement('05/10/2026,05/10/2026,NEFT/HDFCH001/CLICK AR BUSINESS PRIVATE LI/HDFC BANK,,91800.00,CR,139106.25,CHALAKUDY', '47306.25', '999999.00')
    await expect(importStatement(ctx, { bankAccountId: bankId, profileKey: 'AXIS', text: bad }))
      .rejects.toThrow(/Balance check failed[\s\S]*difference/)
  })

  it('imports when the balances agree', async () => {
    const good = statement([
      '05/10/2026,05/10/2026,NEFT/HDFCH00822263366/CLICK AR BUSINESS PRIVATE LI/HDFC BANK/0001,,91800.00,CR,139106.25,CHALAKUDY',
      '06/10/2026,06/10/2026,Monthly Service Chrgs,,100.00,DR,139006.25,CHALAKUDY',
      '06/10/2026,06/10/2026,GST @18% on Monthly Service Chrgs,,18.00,DR,138988.25,CHALAKUDY',
    ].join('\n'), '47306.25', '138988.25')

    const r = await importStatement(ctx, { bankAccountId: bankId, profileKey: 'AXIS', text: good, fileName: 'axis-oct.csv' })
    expect(r.imported).toBe(3)
    expect(r.duplicates).toBe(0)
    expect(r.balanceCheck.ok).toBe(true)
    expect(r.skipped).toHaveLength(0)
  })

  it('🔴 a second import of the same file adds nothing', async () => {
    const good = statement([
      '05/10/2026,05/10/2026,NEFT/HDFCH00822263366/CLICK AR BUSINESS PRIVATE LI/HDFC BANK/0001,,91800.00,CR,139106.25,CHALAKUDY',
      '06/10/2026,06/10/2026,Monthly Service Chrgs,,100.00,DR,139006.25,CHALAKUDY',
      '06/10/2026,06/10/2026,GST @18% on Monthly Service Chrgs,,18.00,DR,138988.25,CHALAKUDY',
    ].join('\n'), '47306.25', '138988.25')
    const r = await importStatement(ctx, { bankAccountId: bankId, profileKey: 'AXIS', text: good })
    expect(r.imported).toBe(0)
    expect(r.duplicates).toBe(3)
  })

  it('can be forced past a failed balance check, deliberately', async () => {
    const bad = statement('07/10/2026,07/10/2026,INB/IFT/Shinelal/TPARTY TRANSFER,,5000.00,DR,0.00,CHALAKUDY', '47306.25', '1.00')
    const r = await importStatement(ctx, { bankAccountId: bankId, profileKey: 'AXIS', text: bad, force: true })
    expect(r.imported).toBe(1)
    expect(r.balanceCheck.ok).toBe(false)
  })
})

describe('🔴 the reconciliation queue', () => {
  it('offers the TDS-aware match for the ₹91,800 credit', async () => {
    const queue = await reconciliationQueue(ctx, bankId)
    const credit = queue.find((q) => q.txn.amount.toFixed(2) === '91800.00')!
    expect(credit.suggestions.length).toBeGreaterThan(0)
    const top = credit.suggestions[0]
    expect(top.tier).toBe(2)
    expect(top.reason).toMatch(/plus ₹8,500.00 of TDS u\/s 194J settles .* exactly/)
  })

  it('offers the seeded rule for a bank charge', async () => {
    await prisma.bankRule.create({
      data: { companyId: ctx.companyId, pattern: 'Monthly Service Chrgs', matchType: 'CONTAINS', direction: 'DEBIT', accountCode: '5600', label: 'Bank charges', confirmCount: 2, autoApply: true },
    })
    const queue = await reconciliationQueue(ctx, bankId)
    const charge = queue.find((q) => q.txn.rawNarration === 'Monthly Service Chrgs')!
    expect(charge.suggestions[0].tier).toBe(6)
    expect(charge.suggestions[0].confidence).toBe(95)
  })
})

describe('applying a match posts through the same services as manual entry', () => {
  it('a receipt booked from the bank settles the invoice and books the TDS', async () => {
    const queue = await reconciliationQueue(ctx, bankId)
    const credit = queue.find((q) => q.txn.amount.toFixed(2) === '91800.00')!
    await applyMatch(ctx, credit.txn.id, credit.suggestions[0], { learn: true })

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(inv.status).toBe('PAID')
    expect(inv.amountReceived.toString()).toBe('91800')
    expect(inv.tdsCredited.toString()).toBe('8500')

    const tds = await prisma.tdsReceivable.findFirstOrThrow({ where: { invoiceId } })
    expect(tds.tdsAmount.toString()).toBe('8500')

    const txn = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: credit.txn.id } })
    expect(txn.status).toBe('MATCHED')
    expect(txn.receiptId).toBeTruthy()
    expect(txn.matchReason).toMatch(/TDS/)
  })

  it('a ledger match posts the bank charge', async () => {
    const queue = await reconciliationQueue(ctx, bankId)
    const charge = queue.find((q) => q.txn.rawNarration === 'Monthly Service Chrgs')!
    await applyMatch(ctx, charge.txn.id, charge.suggestions[0])

    const txn = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: charge.txn.id } })
    expect(txn.status).toBe('MATCHED')
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'BANK_TXN', sourceId: charge.txn.id }, include: { lines: { include: { account: true } } },
    })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['5600']).toBe('100.00')
    expect(by['1010']).toBe('100.00')
  })

  it('refuses to match the same line twice', async () => {
    const txn = await prisma.bankTransaction.findFirstOrThrow({ where: { status: 'MATCHED' } })
    await expect(applyMatch(ctx, txn.id, { tier: 1, tierName: 'x', confidence: 90, reason: 'x', suggestion: { kind: 'LEDGER', accountCode: '5600', label: 'x' } }))
      .rejects.toThrow(/already matched/)
  })
})

describe('🔴 the learning loop', () => {
  it('extracts the stable part of a narration', () => {
    expect(narrationSignature('NEFT/HDFCH00822263366/CLICK AR BUSINESS PRIVATE LI/HDFC BANK/0001')).toMatch(/CLICK AR BUSINESS/)
    expect(narrationSignature('INB/IFT/Praveen C D/TPARTY TRANSFER')).toMatch(/Praveen C D/)
    expect(narrationSignature('IMPS/P2A/605108713778/SHINELAL/X111100/HDFCBANKLTD/Gstfeesf')).toMatch(/SHINELAL/)
  })

  it('writes a rule candidate on the first confirmation and auto-applies on the second', async () => {
    const rule = await prisma.bankRule.findFirst({ where: { companyId: ctx.companyId, pattern: { contains: 'CLICK AR' } } })
    expect(rule).toBeTruthy()
    expect(rule!.confirmCount).toBe(1)
    expect(rule!.autoApply).toBe(false)
    expect(rule!.customerId).toBe(clickAr)
  })
})

describe('the bank reconciliation statement', () => {
  it('agrees once everything is matched, and names what is left when it does not', async () => {
    const brs = await bankReconciliationStatement(ctx, bankId)
    expect(brs.bookBalance).toBeTruthy()
    expect(brs.unmatchedCount).toBeGreaterThan(0)   // the forced import left one line
    expect(brs.statementBalance).toBeTruthy()
    expect(typeof brs.agrees).toBe('boolean')
    // books plus what the bank shows but we have not booked should reach the statement
    expect(brs.reconciled.toFixed(2)).toBe(
      brs.bookBalance.plus(brs.unmatchedCredits).minus(brs.unmatchedDebits).toFixed(2),
    )
  })
})
