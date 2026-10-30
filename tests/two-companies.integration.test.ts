import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { seedAccounts } from '../prisma/seed/accounts'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { trialBalance, profitAndLoss } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import { receivablesAgeing } from '@/server/services/reports/ageing'
import { dashboardSummary } from '@/server/services/dashboard'
import type { RequestContext } from '@/server/context'

/**
 * 🔴 docs/82 §1 — isolation between two companies, proven at runtime.
 *
 * Until now every test in this suite has run against ONE company, and that is precisely the
 * condition under which a missing `companyId` filter cannot be detected: every row belongs to
 * the only company there is, so the query returns the right answer and the test passes. The
 * static sweep (`scripts/scope-sweep.mts`) can show that a filter is absent from a call, but
 * not whether the id it was handed had already been validated upstream — and in this codebase
 * it usually has. So the question "do two entities actually stay apart" is a runtime one.
 *
 * Company B here is a second entity with its own chart of accounts, financial year, document
 * series, customer and invoice. The bill-of-supply path an unregistered proprietor actually
 * needs is docs/82 §5 and is NOT what this fixture is testing; what it tests is that nothing
 * of B's reaches A, and nothing of A's reaches B.
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext
let invoiceA = '', invoiceB = '', custBId = ''
let numberA = '', numberB = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()

  // ── company B, built the way docs/82 §2 says a company must be born ──
  const b = await prisma.company.create({
    data: {
      legalName: 'SECOND ENTITY', constitution: 'PROPRIETORSHIP',
      pan: 'AAAPA1234A', gstin: '32AAAPA1234A1Z5', stateCode: '32',
      registeredAddress: {}, currencyDefault: 'INR', fyStartMonth: 4,
    },
  })
  await seedAccounts(prisma, b.id)
  const fyB = await prisma.financialYear.create({
    data: {
      companyId: b.id, label: '2026-27',
      startsOn: new Date(Date.UTC(2026, 3, 1)), endsOn: new Date(Date.UTC(2027, 2, 31, 23, 59, 59)),
      status: 'OPEN',
    },
  })
  // 🔴 docs/65 §6 — a company with no series for a document type cannot issue one;
  // `allocateNumber` refuses. The positive control below found this the hard way.
  for (const [docType, pattern] of [
    ['TAX_INVOICE', 'SEC/{FY}/{SEQ:4}'],
    ['RECEIPT', 'SECR/{FY}/{SEQ:4}'],
  ] as const) {
    await prisma.documentSeries.create({
      data: { companyId: b.id, financialYearId: fyB.id, docType, prefix: 'SEC', pattern, nextSeq: 1 },
    })
  }
  // 🔴 B needs its own bank account mapped to its own GL 1010, or `createReceipt` throws on
  // the bank lookup and never reaches the invoice check — the cross-entity test below would
  // then pass while proving nothing. Found exactly that way on the first run.
  const bankGlB = await prisma.account.findUniqueOrThrow({
    where: { companyId_code: { companyId: b.id, code: '1010' } },
  })
  await prisma.companyBankAccount.create({ data: {
    companyId: b.id, label: 'B — Current', accountName: 'SECOND ENTITY', accountNo: '000000000001',
    bankName: 'Test Bank', currency: 'INR', ledgerAccountId: bankGlB.id, isDefault: true,
  } })

  // the same human, a member of both — docs/82's "one login, two entities"
  await prisma.userCompany.create({ data: { userId: user.id, companyId: b.id, role: 'OWNER' } })

  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }

  const custA = await prisma.customer.create({ data: {
    companyId: a.id, name: 'Client of A', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })
  custBId = (await prisma.customer.create({ data: {
    companyId: b.id, name: 'Client of B', country: 'IN', stateCode: '32',
    customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
  } })).id

  const draftA = await createInvoice(ctxA, { customerId: custA.id, date: '2026-05-01',
    lines: [{ description: 'Work for A', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }] })
  const sentA = await sendInvoice(ctxA, draftA.id)
  invoiceA = sentA.id; numberA = sentA.number!

  const draftB = await createInvoice(ctxB, { customerId: custBId, date: '2026-05-02',
    lines: [{ description: 'Work for B', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18' }] })
  const sentB = await sendInvoice(ctxB, draftB.id)
  invoiceB = sentB.id; numberB = sentB.number!
})
afterAll(async () => { await prisma.$disconnect() })

describe('two entities, one login', () => {
  it('number from their own series, independently', () => {
    expect(numberA).toMatch(/^ADP\/26-27\/00\d\d$/)
    expect(numberB).toBe('SEC/26-27/0001')
  })

  it('🔴 each P&L reports only its own revenue', async () => {
    const pnlA = await profitAndLoss(ctxA, PERIOD)
    const pnlB = await profitAndLoss(ctxB, PERIOD)
    expect(Number(pnlA.revenue.total)).toBeCloseTo(100000, 2)
    expect(Number(pnlB.revenue.total)).toBeCloseTo(50000, 2)
  })

  it('🔴 each receivables ledger holds only its own invoice', async () => {
    const ledgerA = await accountLedger(ctxA, '1100', PERIOD)
    const ledgerB = await accountLedger(ctxB, '1100', PERIOD)

    expect(ledgerA!.lines.map((l) => l.narration)).toEqual([`Invoice ${numberA}`])
    expect(ledgerB!.lines.map((l) => l.narration)).toEqual([`Invoice ${numberB}`])

    // and the two 1100s are different rows in different charts of accounts
    expect(Number(ledgerA!.account.closing)).toBeCloseTo(118000, 2)
    expect(Number(ledgerB!.account.closing)).toBeCloseTo(59000, 2)
  })

  /**
   * 🔴 These are the assertions that can actually fail.
   *
   * The P&L and the trial balance above join journal lines to per-company `Account` rows, so
   * the chart of accounts is itself a boundary: unscoping the movement query does NOT leak
   * into another company's P&L, which was confirmed by removing the filter and watching every
   * assertion still pass. A leak surfaces where a read reaches DOCUMENTS directly — invoices,
   * customers, receipts — with no account join to save it.
   */
  it('🔴 receivables ageing lists only its own customers', async () => {
    const ageA = await receivablesAgeing(ctxA)
    const ageB = await receivablesAgeing(ctxB)

    expect(ageA.parties.map((p) => p.partyName)).toEqual(['Client of A'])
    expect(ageB.parties.map((p) => p.partyName)).toEqual(['Client of B'])
    expect(Number(ageA.grandTotal)).toBeCloseTo(118000, 2)
    expect(Number(ageB.grandTotal)).toBeCloseTo(59000, 2)
  })

  it('🔴 the dashboard counts only its own documents', async () => {
    const sumA = await dashboardSummary(ctxA)
    const sumB = await dashboardSummary(ctxB)
    expect(JSON.stringify(sumA)).not.toContain('Client of B')
    expect(JSON.stringify(sumB)).not.toContain('Client of A')
  })

  it('both trial balances balance on their own', async () => {
    expect((await trialBalance(ctxA, PERIOD)).balanced).toBe(true)
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
  })

  /**
   * 🔴 The one that matters most: an id from the other entity, handed to a service by a caller
   * who is signed in to this one. Nothing stops a request body carrying it.
   */
  it('refuses a receipt allocated to the other entity\'s invoice', async () => {
    // 🔴 it must fail because the INVOICE is not B's — not because something else was missing
    await expect(createReceipt(ctxB, {
      customerId: custBId, date: '2026-05-20', mode: 'NEFT',
      allocations: [{ invoiceId: invoiceA, amount: '1000' }],
    })).rejects.toThrow(/not found/i)

    // the same call against B's OWN invoice goes through, which is what makes the refusal above
    // evidence of scoping rather than of a broken fixture
    await expect(createReceipt(ctxB, {
      customerId: custBId, date: '2026-05-21', mode: 'NEFT',
      allocations: [{ invoiceId: invoiceB, amount: '1000' }],
    })).resolves.toBeTruthy()

    const stillOpen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA } })
    expect(Number(stillOpen.amountReceived)).toBe(0)
  })

  it('🔴 no journal line of either company carries the other\'s id', async () => {
    const lines = await prisma.journalLine.findMany({
      include: { journalEntry: { select: { companyId: true } }, account: { select: { companyId: true } } },
    })
    const crossed = lines.filter((l) => l.account.companyId !== l.journalEntry.companyId)
    expect(crossed, 'a posting whose account belongs to another company').toEqual([])
  })
})
