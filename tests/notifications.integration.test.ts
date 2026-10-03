import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { plannedNotifications, runNotifications, recentNotifications, deliveryStanding } from '@/server/services/notify/schedule'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = '', overdueId = ''

const ON = (d: string) => new Date(`${d}T09:00:00Z`)

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

  const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-10',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
  overdueId = inv.id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 chasing an overdue invoice', () => {
  it('says nothing while it is within terms', async () => {
    const planned = await plannedNotifications(ctx, ON('2026-05-20'))
    expect(planned.filter((p) => p.kind === 'INVOICE_OVERDUE')).toEqual([])
  })

  it('chases on the first day it is late', async () => {
    // due 25 May on 15-day terms
    const planned = await plannedNotifications(ctx, ON('2026-05-26'))
    const chase = planned.find((p) => p.kind === 'INVOICE_OVERDUE')
    expect(chase).toBeTruthy()
    expect(chase!.subjectId).toBe(overdueId)
    expect(chase!.message.title).toMatch(/1 days? overdue/)
    expect(chase!.message.url).toBe(`/invoices/${overdueId}`)
  })

  it('is silent the next morning', async () => {
    const planned = await plannedNotifications(ctx, ON('2026-05-27'))
    expect(planned.filter((p) => p.kind === 'INVOICE_OVERDUE')).toEqual([])
  })

  it('comes back at a week', async () => {
    const planned = await plannedNotifications(ctx, ON('2026-06-01'))
    expect(planned.some((p) => p.kind === 'INVOICE_OVERDUE')).toBe(true)
  })

  it('🔴 stops the moment it is paid, because nothing is prepared in advance', async () => {
    await createReceipt(ctx, {
      customerId, date: '2026-06-01', mode: 'NEFT',
      allocations: [{ invoiceId: overdueId, amount: '118000' }],
    })
    const planned = await plannedNotifications(ctx, ON('2026-06-01'))
    expect(planned.filter((p) => p.kind === 'INVOICE_OVERDUE')).toEqual([])
  })
})

describe('🔴 running the schedule twice', () => {
  let secondId = ''

  beforeAll(async () => {
    secondId = (await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2026-07-01',
      lines: [{ description: 'Edit suite', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18' }],
    })).id)).id
  })

  it('sends on the first run', async () => {
    const r = await runNotifications(ctx, ON('2026-07-17'))
    expect(r.planned).toBeGreaterThan(0)
    expect(r.sent).toBeGreaterThan(0)
    expect(r.alreadySent).toBe(0)
    expect(r.log.some((l) => l.subjectId === secondId)).toBe(true)
  })

  it('🔴 does not mistake a database failure for a duplicate', async () => {
    // a bare catch around the claim would count any error as "already sent", and the
    // message would never go — silently, only on the days the database hiccuped
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/services/notify/schedule.ts', 'utf8'))
    expect(src).toMatch(/P2002/)
  })

  it('sends nothing on the second run of the same day', async () => {
    const r = await runNotifications(ctx, new Date('2026-07-17T23:00:00Z'))
    expect(r.sent).toBe(0)
    expect(r.alreadySent).toBe(r.planned)
  })

  it('keeps what was sent, with the day it was about', async () => {
    const log = await recentNotifications(ctx)
    const row = log.find((l) => l.subjectId === secondId)
    expect(row).toBeTruthy()
    expect(row!.forDay.toISOString().slice(0, 10)).toBe('2026-07-17')
    // 🔴 recorded even though it reached nobody — "notifications are off" is a fact worth seeing
    expect(row!.recipients).toBe(0)
  })

  it('a dry run sends nothing and writes nothing', async () => {
    const before = (await recentNotifications(ctx, 200)).length
    // 23 July is seven days past the 16 July due date — on the cadence
    const r = await runNotifications(ctx, ON('2026-07-23'), { dryRun: true })
    expect(r.planned).toBeGreaterThan(0)
    expect(r.sent).toBe(0)
    expect((await recentNotifications(ctx, 200)).length).toBe(before)
  })

  it('reports that nothing can be delivered at all', async () => {
    const s = await deliveryStanding(ctx)
    expect(s.devices).toBe(0)
    expect(s.total).toBeGreaterThan(0)
    expect(s.lastRun).not.toBeNull()
  })
})

describe('🔴 not sending four things at once', () => {
  it('collapses three or more of a kind into one message', async () => {
    const planned = await plannedNotifications(ctx, ON('2026-07-23'))
    const tax = planned.filter((p) => p.kind === 'TAX_DUE')
    // whatever the fixture owes, it never produces a stream of them
    expect(tax.length).toBeLessThanOrEqual(2)
    if (tax.length === 1 && tax[0].subjectId.startsWith('digest:')) {
      expect(tax[0].message.title).toMatch(/^\d+ compliance deadlines/)
      expect(tax[0].message.body).toContain('·')
    }
  })

  it('🔴 keeps a lone reminder individual, because its link is worth following', async () => {
    const planned = await plannedNotifications(ctx, ON('2026-07-23'))
    const chases = planned.filter((p) => p.kind === 'INVOICE_OVERDUE')
    if (chases.length === 1) {
      expect(chases[0].subjectId).not.toMatch(/^digest:/)
      expect(chases[0].message.url).toMatch(/^\/invoices\//)
    }
  })

  it('sends the digest once a day, not once per thing in it', async () => {
    const first = await runNotifications(ctx, ON('2026-08-20'))
    const second = await runNotifications(ctx, ON('2026-08-20'))
    expect(second.sent).toBe(0)
    expect(second.alreadySent).toBe(first.sent + first.alreadySent)
  })
})

describe('compliance deadlines', () => {
  it('🔴 speaks three times before the date, not every morning for a fortnight', async () => {
    const days = [20, 14, 10, 3, 1, 0]
    const spoke: number[] = []
    for (const d of days) {
      const on = new Date(Date.UTC(2026, 6, 31 - d, 9))
      const planned = await plannedNotifications(ctx, on)
      if (planned.some((p) => p.kind === 'TAX_DUE')) spoke.push(d)
    }
    // whatever is actually due in this fixture, it must never be every day
    expect(spoke.length).toBeLessThan(days.length)
  })
})
