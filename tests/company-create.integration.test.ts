import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { postJournal } from '@/server/services/accounting/journal'
import { profitAndLoss, trialBalance } from '@/server/services/reports/statements'
import { Decimal } from '@/lib/money'
import type { RequestContext } from '@/server/context'

/**
 * docs/82 §2 — a second entity brought into being.
 *
 * 🔴 The point of these tests is that a company is born COMPLETE. Before this, the only
 * Company row in existence came from the seed, and a hand-made one would have had no chart of
 * accounts, no financial year and no document series — which fails not at creation but later,
 * when somebody tries to raise its first invoice and `allocateNumber` refuses with an
 * instruction pointing at a Settings screen that does not exist (docs/65 §6).
 */

const prisma = new PrismaClient()
let ctxA: RequestContext
let userId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

/** A proprietor's PAN — 4th character P, which is what makes the constitution agree with it. */
const PROP = {
  legalName: 'AKASH — PROPRIETOR', constitution: 'PROPRIETORSHIP' as const,
  pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'SEC',
  address: { line1: 'VIII/318, Chinnangath House', city: 'Thrissur', state: 'Kerala', pincode: '680683' },
}

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  userId = user.id
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }
})
afterAll(async () => { await prisma.$disconnect() })

describe('a second entity, born complete', () => {
  it('🔴 can raise its first invoice on the day it is created', async () => {
    const b = await createCompany(ctxA, PROP)
    const ctxB: RequestContext = { userId, companyId: b.id, role: 'OWNER' }

    const customer = await prisma.customer.create({ data: {
      companyId: b.id, name: 'Client of the proprietor', country: 'IN', stateCode: '32',
      customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
    } })
    const draft = await createInvoice(ctxB, { customerId: customer.id, date: '2026-10-01',
      lines: [{ description: 'Freelance work', sacCode: '998314', quantity: '1', rate: '40000', gstRatePct: '18' }] })
    const sent = await sendInvoice(ctxB, draft.id)

    // its own series, its own numbering, from its own financial year
    expect(sent.number).toBe('SEC/26-27/0001')
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
  })

  it('is owned by whoever created it, or nobody could open it', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    const membership = await prisma.userCompany.findFirstOrThrow({ where: { companyId: b.id, userId } })
    expect(membership.role).toBe('OWNER')
  })

  it('opens its own audit trail with its own creation', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    const first = await prisma.auditLog.findFirstOrThrow({
      where: { companyId: b.id, entity: 'Company' },
    })
    expect(first.action).toBe('CREATE')
  })

  it('gets a proprietor’s equity section, not a company’s', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    const equity = await prisma.account.findMany({
      where: { companyId: b.id, type: 'EQUITY' }, select: { code: true, name: true },
      orderBy: { code: 'asc' },
    })
    expect(equity.map((e) => e.name)).toEqual([
      "Proprietor's Capital", 'Retained Earnings', 'Current Year Profit', 'Drawings',
    ])
  })

  it('does not inherit the other entity’s bank account number', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    const bank = await prisma.account.findUniqueOrThrow({
      where: { companyId_code: { companyId: b.id, code: '1010' } },
    })
    expect(bank.name).toBe('Bank — Current')
    expect(bank.name).not.toContain('9210')
  })

  it('has its expense categories, so an expense can be recorded at all', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    expect(await prisma.expenseCategory.count({ where: { companyId: b.id } })).toBe(9)
  })

  /**
   * 🔴 docs/82 §4 — the guarantee the whole drawings design exists for.
   *
   * Household spending is recorded in full and changes the declared profit by nothing. Booked
   * as an expense instead it would understate the profit the proprietor actually declares,
   * which is the single line between a complete record and a wrong return.
   */
  it('🔴 records household drawings without moving taxable profit', async () => {
    const b = await prisma.company.findFirstOrThrow({ where: { pan: PROP.pan } })
    const ctxB: RequestContext = { userId, companyId: b.id, role: 'OWNER' }

    const before = await profitAndLoss(ctxB, PERIOD)

    await postJournal(ctxB, {
      date: new Date('2026-10-05'), narration: 'Rent, groceries and medical — drawings',
      sourceType: 'MANUAL',
      postings: [
        { accountCode: '3300', debit: new Decimal('85000') },
        { accountCode: '1010', credit: new Decimal('85000') },
      ],
    })

    const after = await profitAndLoss(ctxB, PERIOD)
    expect(Number(after.netProfit)).toBeCloseTo(Number(before.netProfit), 2)
    expect(Number(after.totalExpenses)).toBeCloseTo(Number(before.totalExpenses), 2)
    expect((await trialBalance(ctxB, PERIOD)).balanced).toBe(true)
  })
})

describe('what it refuses', () => {
  it('🔴 a PAN whose 4th character disagrees with the constitution', async () => {
    await expect(createCompany(ctxA, { ...PROP, pan: 'AAUCA9985H', legalName: 'WRONG PAN LTD' }))
      .rejects.toThrow(/does not match|fourth character/i)
  })

  it('an unregistered entity carrying a GSTIN', async () => {
    await expect(createCompany(ctxA, {
      ...PROP, pan: 'AAFPB5678C', legalName: 'CONFUSED ENTITY',
      gstin: '32AAFPB5678C1Z5', gstRegistrationType: 'UNREGISTERED',
    })).rejects.toThrow(/unregistered entity has no GSTIN/i)
  })

  it('a registered entity with no GSTIN to print', async () => {
    await expect(createCompany(ctxA, {
      ...PROP, pan: 'AAFPB5678C', legalName: 'REGISTERED SOMEHOW', gstRegistrationType: 'REGULAR',
    })).rejects.toThrow(/needs its GSTIN/i)
  })

  it('a GSTIN from another state', async () => {
    await expect(createCompany(ctxA, {
      ...PROP, pan: 'AAFPB5678C', legalName: 'WRONG STATE', gstin: '29AAFPB5678C1Z5',
    })).rejects.toThrow(/not state 32|first two characters/i)
  })

  it('a GSTIN that does not carry its own PAN', async () => {
    await expect(createCompany(ctxA, {
      ...PROP, pan: 'AAFPB5678C', legalName: 'MISMATCHED', gstin: '32AAAPA1234A1Z5',
    })).rejects.toThrow(/does not carry PAN/i)
  })

  /**
   * 🔴 Postgres treats NULLs as distinct in a unique index, so `@@unique([pan, gstin])` lets
   * two unregistered entities share a PAN. Two unregistered businesses on one PAN are one
   * taxpayer filing one return, so the service refuses what the database cannot.
   */
  it('🔴 the same taxpayer a second time, which the unique index allows', async () => {
    await expect(createCompany(ctxA, { ...PROP, legalName: 'SAME PERSON AGAIN' }))
      .rejects.toThrow(/same taxpayer|already/i)
  })

  it('a series prefix that is not 2 to 4 letters', async () => {
    await expect(createCompany(ctxA, { ...PROP, pan: 'AAFPB5678C', seriesPrefix: 'TOOLONG' }))
      .rejects.toThrow(/2 to 4 letters/i)
  })

  it('anyone who is not an owner', async () => {
    const asAccountant: RequestContext = { ...ctxA, role: 'ACCOUNTANT' }
    await expect(createCompany(asAccountant, { ...PROP, pan: 'AAFPB5678C' }))
      .rejects.toThrow()
  })
})
