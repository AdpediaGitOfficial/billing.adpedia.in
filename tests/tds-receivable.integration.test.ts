import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { receivableSummary, form16aChaseList, markForm16aReceived } from '@/server/services/tax/tds-receivable'
import { import26as, reconcile26as } from '@/server/services/tax/form26as'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let fyId = '', clickAr = '', nuve = ''
const DATE = '2026-08-20'

const lines = (rate: string) => [{ description: 'Development', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }]

async function billAndCollect(customerId: string, rate: string, tdsSection: '194J' | '194C', tds: string, cash: string) {
  const d = await createInvoice(ctx, { customerId, date: DATE, tdsSection, lines: lines(rate) })
  const inv = await sendInvoice(ctx, d.id)
  await createReceipt(ctx, { customerId, date: DATE, mode: 'NEFT', allocations: [{ invoiceId: inv.id, amount: cash, tdsAmount: tds }] })
  return inv
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })).id

  clickAr = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Pvt Ltd', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', tan: 'TVDC12345E', customerType: 'B2B', billingAddress: {}, paymentTermDays: 15, defaultTdsSection: '194J',
  } })).id
  nuve = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Nuvé Properties Pvt Ltd', country: 'IN', stateCode: '27',
    gstin: '27AABCN1234M1Z5', tan: 'MUMN54321B', customerType: 'B2B', billingAddress: {}, paymentTermDays: 15, defaultTdsSection: '194C',
  } })).id

  // Click AR deducts 194J on ₹85,000 → ₹8,500; Nuvé deducts 194C on ₹200,000 → ₹4,000
  await billAndCollect(clickAr, '85000', '194J', '8500', '91800')
  await billAndCollect(nuve, '200000', '194C', '4000', '232000')
})
afterAll(async () => { await prisma.$disconnect() })

describe('TDS receivable is booked on receipt', () => {
  it('records what each client deducted, by section and quarter', async () => {
    const s = await receivableSummary(ctx, fyId)
    expect(s.rows).toHaveLength(2)
    expect(s.booked.toFixed(2)).toBe('12500.00')
    expect(s.rows.every((r) => r.status === 'BOOKED')).toBe(true)
    expect(s.rows.every((r) => r.quarter === 2)).toBe(true)      // August is Q2
    expect(s.bySection.map((x) => x.section).sort()).toEqual(['194C', '194J'])
  })

  it('nothing is matched until 26AS is imported', async () => {
    const s = await receivableSummary(ctx, fyId)
    expect(s.matched.toFixed(2)).toBe('0.00')
    expect(s.missing.toFixed(2)).toBe('12500.00')
  })
})

describe('🔴 reconciliation against Form 26AS', () => {
  it('matches what the department has against what the books say', async () => {
    const csv = `
Sr,Name,TAN,Section,Date,Status,Paid,Deducted
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00
2,NUVE PROPERTIES PVT LTD,MUMN54321B,194C,20-Aug-2026,F,200000.00,4000.00
`.trim()
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)

    expect(r.matched).toHaveLength(2)
    expect(r.missingIn26as).toHaveLength(0)
    expect(r.notInBooks).toHaveLength(0)
    expect(r.totals.matchedAmount.toFixed(2)).toBe('12500.00')
    expect(r.matched.every((m) => m.tier.startsWith('exact'))).toBe(true)

    const s = await receivableSummary(ctx, fyId)
    expect(s.matched.toFixed(2)).toBe('12500.00')
    expect(s.rows.every((x) => x.status === 'MATCHED_26AS')).toBe(true)
  })

  it('🔴 flags a credit the client deducted but never filed', async () => {
    // 26AS now carries only Click AR — Nuvé deducted but did not file
    const csv = `1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00`
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)

    expect(r.matched).toHaveLength(1)
    expect(r.missingIn26as).toHaveLength(1)
    const gap = r.missingIn26as[0]
    expect(gap.customerName).toBe('Nuvé Properties Pvt Ltd')
    expect(gap.amount.toFixed(2)).toBe('4000.00')
    expect(gap.action).toMatch(/Form 16A for Q2/)
    expect(gap.action).toMatch(/lost, not deferred/)
    expect(r.totals.missingAmount.toFixed(2)).toBe('4000.00')
  })

  it('🔴 flags a credit in 26AS with nothing behind it in the books', async () => {
    const csv = `
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00
2,NUVE PROPERTIES PVT LTD,MUMN54321B,194C,20-Aug-2026,F,200000.00,4000.00
3,UNKNOWN CLIENT PRIVATE LIMITED,DELU99999X,194J,10-Sep-2026,F,150000.00,15000.00
`.trim()
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)

    expect(r.matched).toHaveLength(2)
    expect(r.notInBooks).toHaveLength(1)
    expect(r.notInBooks[0].deductorName).toMatch(/UNKNOWN CLIENT/)
    expect(r.notInBooks[0].amount.toFixed(2)).toBe('15000.00')
    expect(r.notInBooks[0].action).toMatch(/not in the books/)
    expect(r.notInBooks[0].action).toMatch(/never raised|not recorded/)
    expect(r.totals.extraAmount.toFixed(2)).toBe('15000.00')
  })

  it('still matches when the client filed under a different section', async () => {
    // Nuvé filed the 194C deduction as 194J
    const csv = `
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00
2,NUVE PROPERTIES PVT LTD,MUMN54321B,194J,20-Aug-2026,F,200000.00,4000.00
`.trim()
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)
    expect(r.matched).toHaveLength(2)
    expect(r.matched.some((m) => m.tier.includes('section differs'))).toBe(true)
    expect(r.missingIn26as).toHaveLength(0)
  })

  it('still matches when the client filed it in another quarter', async () => {
    const csv = `
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00
2,NUVE PROPERTIES PVT LTD,MUMN54321B,194C,10-Dec-2026,F,200000.00,4000.00
`.trim()
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)
    expect(r.matched).toHaveLength(2)
    expect(r.matched.some((m) => m.tier.includes('quarter differs'))).toBe(true)
  })

  it('a re-import replaces the previous one rather than doubling it', async () => {
    const csv = `1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00`
    await import26as(ctx, csv, fyId)
    await import26as(ctx, csv, fyId)
    expect(await prisma.form26asEntry.count({ where: { companyId: ctx.companyId, financialYearId: fyId } })).toBe(1)
  })

  it('refuses a file it cannot read at all', async () => {
    await expect(import26as(ctx, 'total rubbish with no structure 12345', fyId))
      .rejects.toThrow(/Nothing readable/)
  })

  it('cannot match a client with no TAN on record, and says so', async () => {
    await prisma.customer.update({ where: { id: nuve }, data: { tan: null } })
    await prisma.tdsReceivable.updateMany({ where: { customerId: nuve }, data: { deductorTan: null } })
    const csv = `1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00`
    await import26as(ctx, csv, fyId)
    const r = await reconcile26as(ctx, fyId)
    expect(r.missingIn26as[0].action).toMatch(/No TAN on record/)
    await prisma.customer.update({ where: { id: nuve }, data: { tan: 'MUMN54321B' } })
  })
})

describe('the Form 16A chase list', () => {
  it('groups by client with the amount and quarters outstanding', async () => {
    const list = await form16aChaseList(ctx, fyId)
    expect(list.length).toBeGreaterThan(0)
    const top = list[0]
    expect(top.message).toMatch(/deducted ₹.*but has not issued Form 16A/)
    expect(top.quarters).toContain(2)
  })

  it('marks certificates as received', async () => {
    const s = await receivableSummary(ctx, fyId)
    await markForm16aReceived(ctx, s.rows.map((r) => r.id))
    expect(await form16aChaseList(ctx, fyId)).toHaveLength(0)
  })
})
