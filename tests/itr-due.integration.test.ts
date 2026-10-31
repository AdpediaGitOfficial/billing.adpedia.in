import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import { rocYears } from '@/server/services/compliance/roc'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import type { RequestContext } from '@/server/context'

/**
 * docs/82 §5d — the ITR date on the calendar, for each kind of entity.
 *
 * 🔴 The item said *"File the company income tax return"* on **31 October** to everybody,
 * because the calendar was written when there was one entity and it was a company. The
 * proprietorship docs/82 added owes 31 July under s.139(1)(c) — and would have been shown a
 * date three months past it, with nothing in the system ever noticing.
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext
const NOW = new Date('2026-10-31')
const item = (items: Awaited<ReturnType<typeof complianceCalendar>>, id: string) =>
  items.find((i) => i.id === id)

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }

  const b = await createCompany(ctxA, {
    legalName: 'AKASH — PROPRIETOR', constitution: 'PROPRIETORSHIP',
    pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'SEC',
    address: { line1: 'VIII/318, Chinnangath House', city: 'Thrissur', state: 'Kerala', pincode: '680683' },
  })
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }

  // 🔴 turnover of its own, or the position is decided on an empty P&L and the test proves
  // only that nothing happened
  const customer = await prisma.customer.create({ data: {
    companyId: b.id, name: 'Client of the proprietor', country: 'IN', stateCode: '32',
    customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
  } })
  const draft = await createInvoice(ctxB, { customerId: customer.id, date: '2026-09-01',
    lines: [{ description: 'Freelance work', sacCode: '998314', quantity: '1', rate: '450000', gstRatePct: '0' }] })
  await sendInvoice(ctxB, draft.id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 the date each entity actually owes', () => {
  it('🔴 the proprietorship: 31 July, and it is the proprietor’s own return', async () => {
    const itr = item(await complianceCalendar(ctxB, NOW), 'itr-current')!
    expect(itr.dueOn.toISOString().slice(0, 10)).toBe('2027-07-31')
    expect(itr.title).toContain('proprietor')
    expect(itr.title).not.toContain('company')
    expect(itr.detail).toContain('ITR-3')
  })

  it('the company: 31 October, under clause (a) rather than by its size', async () => {
    const itr = item(await complianceCalendar(ctxA, NOW), 'itr-current')!
    expect(itr.dueOn.toISOString().slice(0, 10)).toBe('2027-10-31')
    expect(itr.title).toContain('company')
    expect(itr.detail).toContain('ITR-6')
  })

  it('and for the year that has ended, which is the one that is actually due', async () => {
    const itr = item(await complianceCalendar(ctxA, NOW), 'itr')!
    expect(itr.title).toContain('2025-26')
    expect(itr.dueOn.toISOString().slice(0, 10)).toBe('2026-10-31')
  })

  /**
   * 🔴 The report is the half that depends on somebody else's diary, and it is due a month
   * before the return that cannot go without it.
   */
  it('🔴 asks the company for its tax audit report on 30 September', async () => {
    const report = item(await complianceCalendar(ctxA, NOW), 'tax-audit-report')!
    expect(report.dueOn.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(report.detail).toMatch(/3CD/)
  })

  it('and asks the proprietorship for no report at all, because none is due', async () => {
    expect(item(await complianceCalendar(ctxB, NOW), 'tax-audit-report')).toBeUndefined()
  })

  /**
   * 🔴 The settings screen records the filing against the same date the calendar chases. Two
   * computations of one deadline is how a screen comes to disagree with the reminder.
   */
  it('🔴 the annual-filings screen shows the same date', async () => {
    const [yearA] = await rocYears(ctxA, NOW)
    const calendar = item(await complianceCalendar(ctxA, NOW), 'itr')!
    expect(yearA.itr.dueOn.toISOString()).toBe(calendar.dueOn.toISOString())
    expect(yearA.itr.form).toBe('ITR-6')
  })
})
