import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import {
  recordOwnerMovement, drawingsSummary, hasDrawings, DRAWING_PURPOSES,
} from '@/server/services/equity/drawings'
import { createExpense } from '@/server/services/purchases/expense'
import { profitAndLoss, trialBalance, balanceSheet } from '@/server/services/reports/statements'
import { accountBalances } from '@/server/services/reports/ledger'
import { Decimal } from '@/lib/money'
import type { RequestContext } from '@/server/context'

/**
 * docs/82 §4 — drawings, and the one line they exist to protect.
 *
 * 🔴 A proprietor and their proprietorship are one person for income tax, so money moves
 * between them constantly and ALL of it has to be recorded: a bank statement with unexplained
 * debits is not a set of books. None of it may touch the declared profit. An equity contra is
 * what makes both true at once, and these tests are that claim stated as arithmetic.
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const PROP = {
  legalName: 'AKASH — PROPRIETOR', constitution: 'PROPRIETORSHIP' as const,
  pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'SEC',
  address: { line1: 'VIII/318, Chinnangath House', city: 'Thrissur', state: 'Kerala', pincode: '680683' },
}

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()

  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }
  const b = await createCompany(ctxA, PROP)
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 recorded in full, and deducted nowhere', () => {
  it('🔴 household spending does not move the declared profit by a paisa', async () => {
    const before = await profitAndLoss(ctxB, PERIOD)

    for (const [purpose, amount, note] of [
      ['RENT', '18000', 'October rent, Chalakudy'],
      ['HOUSEHOLD', '12500', 'Groceries and the month'],
      ['MEDICAL', '4200', 'Pharmacy and a consultation'],
      ['PERSONAL_TAX', '25000', 'Second advance-tax instalment, personal'],
    ] as const) {
      await recordOwnerMovement(ctxB, {
        kind: 'DRAWING', date: '2026-10-05', amount, purpose, narration: note, source: 'BANK',
      })
    }

    const after = await profitAndLoss(ctxB, PERIOD)
    expect(Number(after.netProfit)).toBeCloseTo(Number(before.netProfit), 2)
    expect(Number(after.totalExpenses)).toBeCloseTo(Number(before.totalExpenses), 2)
  })

  it('🔴 but every rupee of it is in the books, against 3300', async () => {
    const balances = await accountBalances(ctxB, PERIOD)
    const drawings = balances.find((b) => b.code === '3300')
    expect(drawings, 'the drawings account has no movement at all').toBeTruthy()
    // 18000 + 12500 + 4200 + 25000, as a DEBIT to an equity account
    expect(Number(drawings!.debit)).toBeCloseTo(59700, 2)
  })

  it('and the books still balance, which an equity contra has to', async () => {
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
    expect((await balanceSheet(ctxB, PERIOD.to, PERIOD.from)).balanced).toBe(true)
  })

  it('reduces the owner’s funds by what was taken', async () => {
    const s = await drawingsSummary(ctxB, PERIOD)
    expect(Number(s.drawn)).toBeCloseTo(59700, 2)
    expect(Number(s.introduced)).toBeCloseTo(0, 2)
    expect(Number(s.net)).toBeCloseTo(59700, 2)
  })

  /**
   * 🔴 One number, not two. Summing the equity ACCOUNTS would read −59,700 for eleven months
   * of the year, because this year's profit does not reach `3200 Current Year Profit` until
   * the year-end close — so the drawings screen would have disagreed with the balance sheet
   * somebody checks it against, and neither figure would then be worth anything.
   */
  it('🔴 reports the same owner’s funds the balance sheet does', async () => {
    const s = await drawingsSummary(ctxB, PERIOD)
    const bs = await balanceSheet(ctxB, PERIOD.to, PERIOD.from)
    expect(Number(s.ownerFunds)).toBeCloseTo(Number(bs.equity.total), 2)
    expect(bs.balanced).toBe(true)
  })

  it('keeps the purpose, because the personal return is prepared from it', async () => {
    const s = await drawingsSummary(ctxB, PERIOD)
    const rent = s.byPurpose.find((p) => p.purpose === 'RENT')
    expect(Number(rent?.total)).toBeCloseTo(18000, 2)
    // sorted by size, so the biggest drawing leads
    expect(s.byPurpose[0].purpose).toBe('PERSONAL_TAX')
  })

  it('every purpose the UI offers says where it IS deductible, which is never here', () => {
    expect(DRAWING_PURPOSES.length).toBeGreaterThanOrEqual(6)
    for (const p of DRAWING_PURPOSES) expect(p.note.length).toBeGreaterThan(20)
  })

  it('capital introduced goes the other way and nets off', async () => {
    await recordOwnerMovement(ctxB, {
      kind: 'CAPITAL', date: '2026-10-06', amount: '40000',
      narration: 'Transfer from savings to fund the account',
    })
    const s = await drawingsSummary(ctxB, PERIOD)
    expect(Number(s.introduced)).toBeCloseTo(40000, 2)
    expect(Number(s.net)).toBeCloseTo(19700, 2)
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
  })
})

describe('what it refuses', () => {
  /**
   * 🔴 The refusal that is really a tax point. A company's director taking money out has done
   * one of three things, each with its own consequence — and none of them is a drawing.
   */
  it('🔴 a company has no drawings', async () => {
    await expect(recordOwnerMovement(ctxA, {
      kind: 'DRAWING', date: '2026-10-05', amount: '50000', purpose: 'HOUSEHOLD',
      narration: 'The director took it out',
    })).rejects.toThrow(/company has no drawings/i)
  })

  it('and says which three things it might have been instead', async () => {
    await expect(recordOwnerMovement(ctxA, {
      kind: 'DRAWING', date: '2026-10-05', amount: '50000', purpose: 'HOUSEHOLD', narration: 'x y z',
    })).rejects.toThrow(/s\.192[\s\S]*dividend[\s\S]*s\.185/)
  })

  it('a drawing with no purpose, which is the field that makes it usable', async () => {
    await expect(recordOwnerMovement(ctxB, {
      kind: 'DRAWING', date: '2026-10-05', amount: '1000', narration: 'Took some money',
    })).rejects.toThrow(/Pick what the money was for/i)
  })

  it('a purpose on capital coming in, which needs no story', async () => {
    await expect(recordOwnerMovement(ctxB, {
      kind: 'CAPITAL', date: '2026-10-05', amount: '1000', purpose: 'RENT', narration: 'Put it back',
    })).rejects.toThrow(/no purpose to record/i)
  })

  it('an unexplained amount', async () => {
    await expect(recordOwnerMovement(ctxB, {
      kind: 'DRAWING', date: '2026-10-05', amount: '1000', purpose: 'OTHER', narration: 'x',
    })).rejects.toThrow(/Say what the money was for/i)
  })

  it('a negative or zero drawing', async () => {
    await expect(recordOwnerMovement(ctxB, {
      kind: 'DRAWING', date: '2026-10-05', amount: '0', purpose: 'OTHER', narration: 'Nothing at all',
    })).rejects.toThrow(/positive amount/i)
  })

  it('🔴 a bank account belonging to the other entity', async () => {
    const theirs = await prisma.companyBankAccount.findFirstOrThrow({
      where: { companyId: ctxA.companyId, isDefault: true },
    })
    await expect(recordOwnerMovement(ctxB, {
      kind: 'DRAWING', date: '2026-10-05', amount: '1000', purpose: 'OTHER',
      narration: 'Out of the wrong account', bankAccountId: theirs.id,
    })).rejects.toThrow(/does not belong to this entity/i)
  })

  it('and the database refuses to let one be deleted', async () => {
    const m = await prisma.ownerMovement.findFirstOrThrow({
      where: { companyId: ctxB.companyId, narration: 'October rent, Chalakudy' },
    })
    await expect(prisma.ownerMovement.delete({ where: { id: m.id } })).rejects.toThrow(/never hard-deleted/i)
  })

  it('knows which constitutions have drawings at all', () => {
    expect(hasDrawings('PROPRIETORSHIP')).toBe(true)
    expect(hasDrawings('PARTNERSHIP')).toBe(true)
    expect(hasDrawings('LLP')).toBe(true)
    expect(hasDrawings('PRIVATE_LIMITED')).toBe(false)
    expect(hasDrawings('PUBLIC_LIMITED')).toBe(false)
  })
})

/**
 * docs/82 §5b — B's own expense categories.
 *
 * 🔴 The nine categories were A's, and seeded unchanged they told entity B it could claim
 * input credit and should deduct TDS. Both are wrong for it, and neither failed: the GST went
 * into `1210 Input CGST` as an asset that can never be utilised, which understates the cost by
 * the tax and leaves a receivable from nobody on the balance sheet.
 */
describe('🔴 the categories an unregistered proprietor can actually act on', () => {
  it('offers no input credit, because s.16(1) gives it to a registered person', async () => {
    const cats = await prisma.expenseCategory.findMany({ where: { companyId: ctxB.companyId } })
    expect(cats.length).toBe(9)
    expect(cats.every((c) => c.itcDefault === 'BLOCKED')).toBe(true)
    expect(cats.every((c) => c.rcmPossible === false)).toBe(true)
  })

  /**
   * 🔴 s.194C and s.194J exclude an individual below the s.44AB limits — which is the same
   * ₹1 crore docs/82 §8 watches with an ₹80 lakh alert. A company has no such exclusion.
   */
  it('🔴 deducts no TDS, because a small proprietor is not a person liable to', async () => {
    const b = await prisma.expenseCategory.findMany({ where: { companyId: ctxB.companyId } })
    expect(b.every((c) => c.tdsSection === null)).toBe(true)

    const a = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctxA.companyId, code: 'VENDOR' },
    })
    expect(a.tdsSection, 'the company still deducts from the first rupee').toBe('194J')
  })

  it('🔴 puts the tax into the cost, not into an input-credit asset', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctxB.companyId, code: 'INTERNET' },
    })
    // the supplier charged GST; B pays it and claims nothing
    const expense = await createExpense(ctxB, {
      categoryId: category.id, date: '2026-10-07', description: 'Broadband, October',
      taxableValue: '1000', gstMode: 'INTRA', gstRatePct: '18',
    })
    expect(expense.itcEligible).toBe(false)
    expect(Number(expense.total)).toBeCloseTo(1180, 2)
    expect(expense.itcBlockedReason).toMatch(/s\.16\(1\)/)

    const balances = await accountBalances(ctxB, PERIOD, { includeZero: true })
    const inputCgst = balances.find((b) => b.code === '1210')!
    expect(Number(inputCgst.debit), 'input credit for an entity that cannot claim it').toBe(0)
    // 🔴 the whole 1,180 is the cost of the expense
    const internet = balances.find((b) => b.code === '5320')!
    expect(Number(internet.debit)).toBeCloseTo(1180, 2)
  })

  it('refuses an override that would claim it anyway', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctxB.companyId, code: 'OFFICE' },
    })
    await expect(createExpense(ctxB, {
      categoryId: category.id, date: '2026-10-07', description: 'Stationery',
      taxableValue: '1000', gstMode: 'INTRA', gstRatePct: '18', itcEligible: true,
    })).rejects.toThrow(/not registered for GST[\s\S]*s\.16\(1\)/)
  })

  it('and the registered entity still claims its credit', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctxA.companyId, code: 'INTERNET' },
    })
    const expense = await createExpense(ctxA, {
      categoryId: category.id, date: '2026-10-07', description: 'Broadband, October',
      taxableValue: '1000', gstMode: 'INTRA', gstRatePct: '18',
    })
    expect(expense.itcEligible).toBe(true)
    const balances = await accountBalances(ctxA, PERIOD)
    expect(Number(balances.find((b) => b.code === '1210')!.debit)).toBeGreaterThan(0)
  })

  it('🔴 no reason from the s.17(5) list is demanded, because none of them apply', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctxB.companyId, code: 'TRAVEL' },
    })
    // before this, blocking credit with tax on the line threw "pick the clause that applies"
    // — and for an unregistered entity there is no clause to pick
    const e = await createExpense(ctxB, {
      categoryId: category.id, date: '2026-10-08', description: 'Train to the shoot',
      taxableValue: '500', gstMode: 'INTRA', gstRatePct: '5',
    })
    expect(Number(e.total)).toBeCloseTo(525, 2)
  })
})

describe('the money trail is complete', () => {
  it('🔴 the bank account shows the drawings as actual withdrawals', async () => {
    const balances = await accountBalances(ctxB, PERIOD, { includeZero: true })
    const bank = balances.find((b) => b.code === '1010')!
    // 59,700 drawn + 1,180 + 525 of expenses, less 40,000 put back
    expect(Number(bank.credit)).toBeCloseTo(61405, 2)
    expect(Number(bank.debit)).toBeCloseTo(40000, 2)
  })

  it('and the P&L carries only the two business expenses', async () => {
    const pnl = await profitAndLoss(ctxB, PERIOD)
    expect(Number(pnl.totalExpenses)).toBeCloseTo(1705, 2)
    expect(new Decimal(pnl.totalExpenses.toString()).lt(59700)).toBe(true)
  })
})
