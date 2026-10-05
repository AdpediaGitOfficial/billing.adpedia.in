import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice } from '@/server/services/invoicing/invoice'
import { paginate, PAGE_SIZE } from '@/lib/paging'
import type { RequestContext } from '@/server/context'

/**
 * docs/78 — a paginated list needs a TOTAL order, or it repeats rows and loses others.
 *
 * 🔴 The invoices list ordered by `date desc, seq desc`, and every DRAFT carries `seq: 0`.
 * Fifty drafts on one date therefore had no order between them at all, so the database is free
 * to return them differently for page 1 and page 2 — the same invoice twice, another never.
 * Unpaginated this only looked untidy. Paginated it loses rows, and nothing says so.
 */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  customerId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })).id

  // 🔴 every one of them a DRAFT, on ONE date — the case with no natural order
  for (let i = 0; i < PAGE_SIZE + 12; i++) {
    await createInvoice(ctx, {
      customerId, date: '2026-08-10',
      lines: [{ description: `Line ${i}`, rate: String(1000 + i), quantity: '1', gstRatePct: '18' }],
    })
  }
})
afterAll(async () => { await prisma.$disconnect() })

const where = () => ({ companyId })

async function pageOf(n: number, orderBy: object[]) {
  const page = paginate(await prisma.invoice.count({ where: where() }), n)
  const rows = await prisma.invoice.findMany({
    where: where(), orderBy, skip: page.skip, take: page.take, select: { id: true },
  })
  return { page, ids: rows.map((r) => r.id) }
}

describe('🔴 a paginated list needs a total order', () => {
  it('returns every row exactly once, over two pages', async () => {
    const order = [{ date: 'desc' as const }, { seq: 'desc' as const }, { id: 'desc' as const }]
    const first = await pageOf(1, order)
    const second = await pageOf(2, order)

    expect(first.ids).toHaveLength(PAGE_SIZE)
    expect(second.ids).toHaveLength(12)

    const all = [...first.ids, ...second.ids]
    expect(new Set(all).size).toBe(first.page.total)
    expect(all).toHaveLength(first.page.total)
  })

  /**
   * 🔴 And the same two pages, read again, are the same two pages. Without the tiebreak the
   * database may order the equal rows differently between queries, which is what loses them.
   */
  it('is stable across repeated reads', async () => {
    const order = [{ date: 'desc' as const }, { seq: 'desc' as const }, { id: 'desc' as const }]
    const a = await pageOf(1, order)
    const b = await pageOf(1, order)
    expect(a.ids).toEqual(b.ids)
  })

  it('clamps a page past the end onto the last one rather than showing nothing', async () => {
    const order = [{ date: 'desc' as const }, { seq: 'desc' as const }, { id: 'desc' as const }]
    const far = await pageOf(99, order)
    expect(far.page.page).toBe(far.page.pages)
    expect(far.ids.length).toBeGreaterThan(0)
  })
})

/**
 * 🔴 The figures a list shows must be over EVERYTHING, not over the page.
 *
 * `live.reduce(...)` was correct while the list was everything. Paginated, it silently becomes
 * "collected on this page", and the figure changes every time somebody presses Next — which is
 * the fastest way to make a tile untrustworthy.
 */
describe('🔴 the totals are the company position, not the page', () => {
  it('aggregates in the database over every row', async () => {
    const page = paginate(await prisma.invoice.count({ where: where() }), 1)
    const onPage = await prisma.invoice.findMany({
      where: where(), orderBy: [{ date: 'desc' }, { seq: 'desc' }, { id: 'desc' }],
      skip: page.skip, take: page.take, select: { grandTotal: true },
    })
    const all = await prisma.invoice.aggregate({ where: where(), _sum: { grandTotal: true } })

    const pageSum = onPage.reduce((a, r) => a + Number(r.grandTotal), 0)
    expect(Number(all._sum.grandTotal)).toBeGreaterThan(pageSum)
  })
})
