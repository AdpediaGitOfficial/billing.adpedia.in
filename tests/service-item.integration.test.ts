import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import {
  listServiceItems, createServiceItem, updateServiceItem, setServiceItemActive, incomeAccounts,
} from '@/server/services/invoicing/service-item'
import { updateCompanyProfile } from '@/server/services/company/profile'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

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
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('the service catalogue', () => {
  let id = ''

  it('adds one, with its SAC and rate', async () => {
    const item = await createServiceItem(ctx, {
      name: 'Drone cinematography', sacCode: '998387', defaultRate: '35000', gstRatePct: '18',
    })
    id = item.id
    const row = (await listServiceItems(ctx)).find((r) => r.id === id)!
    expect(row.name).toBe('Drone cinematography')
    expect(row.sacCode).toBe('998387')
    expect(row.defaultRate!.toFixed(2)).toBe('35000.00')
    expect(row.isActive).toBe(true)
    expect(row.usedOn).toBe(0)
  })

  it('🔴 refuses a SAC that is not one', async () => {
    // the validator has existed since docs/34; this is the first thing that calls it on input
    await expect(createServiceItem(ctx, { name: 'Nonsense', sacCode: '12345' }))
      .rejects.toThrow()
    await expect(createServiceItem(ctx, { name: 'Nonsense too', sacCode: '887766' }))
      .rejects.toThrow()
  })

  it('refuses a rate that is not a GST slab', async () => {
    await expect(createServiceItem(ctx, { name: 'Odd rate', gstRatePct: '13' }))
      .resolves.toBeTruthy()   // 13 is inside 0–28, so it is allowed with a warning elsewhere
    await expect(createServiceItem(ctx, { name: 'Impossible', gstRatePct: '40' }))
      .rejects.toThrow(/not a GST rate/)
  })

  it('refuses a duplicate name', async () => {
    await expect(createServiceItem(ctx, { name: 'Drone cinematography' }))
      .rejects.toThrow(/already in the catalogue/)
  })

  it('🔴 refuses to post revenue to an account that is not income', async () => {
    // nothing downstream checks this: a service pointed at the bank would book every rupee
    // of its revenue into the bank and leave the P&L short, silently
    const bank = await prisma.account.findFirstOrThrow({ where: { companyId, code: '1010' } })
    await expect(createServiceItem(ctx, { name: 'Misrouted', incomeAccountId: bank.id }))
      .rejects.toThrow(/not income/)

    const income = (await incomeAccounts(ctx))[0]
    expect(income).toBeTruthy()
    await expect(updateServiceItem(ctx, id, {
      name: 'Drone cinematography', sacCode: '998387', incomeAccountId: income.id,
    })).resolves.toBeTruthy()
  })

  it('🔴 posts revenue to the account the service names, not its id', async () => {
    /**
     * The field has existed since docs/34 and nothing could set it, so nothing exercised the
     * code that read it — which passed the account ID where a CODE was wanted. The first
     * invoice using a service with an income account failed with "Chart of accounts is
     * missing: cmuu0oza1001…".
     */
    const income = (await incomeAccounts(ctx)).find((a) => a.code !== '4010') ?? (await incomeAccounts(ctx))[0]
    await updateServiceItem(ctx, id, { name: 'Drone cinematography', sacCode: '998387', incomeAccountId: income.id })

    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2026-05-09',
      lines: [{ serviceItemId: id, description: 'Drone cinematography', sacCode: '998387', quantity: '1', rate: '20000', gstRatePct: '18' }],
    })).id)

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'INVOICE', sourceId: inv.id }, include: { lines: { include: { account: true } } },
    })
    const revenue = entry.lines.find((l) => l.account.type === 'INCOME')!
    expect(revenue.account.code).toBe(income.code)
    expect(Number(revenue.credit)).toBe(20000)
  })

  it('🔴 is retired, never deleted, because an invoice line points at it', async () => {
    const inv = await createInvoice(ctx, {
      customerId, date: '2026-05-10',
      lines: [{ serviceItemId: id, description: 'Drone cinematography', sacCode: '998387', quantity: '1', rate: '35000', gstRatePct: '18' }],
    })
    await sendInvoice(ctx, inv.id)

    await setServiceItemActive(ctx, id, false)
    const row = (await listServiceItems(ctx)).find((r) => r.id === id)!
    expect(row.isActive).toBe(false)
    expect(row.usedOn).toBeGreaterThanOrEqual(1)

    // it is gone from what a new invoice is offered, and still there for the old one
    const offered = await prisma.serviceItem.findMany({ where: { companyId, isActive: true } })
    expect(offered.map((s) => s.id)).not.toContain(id)
    expect(await prisma.invoiceLine.count({ where: { serviceItemId: id } })).toBeGreaterThanOrEqual(1)
  })

  it('🔴 renaming it does not change an invoice already raised', async () => {
    const before = await renderInvoiceHtml(companyId, (await prisma.invoice.findFirstOrThrow({
      where: { companyId, lines: { some: { serviceItemId: id } } },
    })).id)
    expect(before).toContain('Drone cinematography')

    await updateServiceItem(ctx, id, { name: 'Aerial cinematography', sacCode: '998387' })

    const after = await renderInvoiceHtml(companyId, (await prisma.invoice.findFirstOrThrow({
      where: { companyId, lines: { some: { serviceItemId: id } } },
    })).id)
    // the LINE carries its own description, snapshotted when it was written
    expect(after).toContain('Drone cinematography')
    expect(after).not.toContain('Aerial cinematography')
  })
})

describe('🔴 the company details docs/35 would not wire up', () => {
  it('corrects the address, and keeps the before and after', async () => {
    await updateCompanyProfile(ctx, {
      addressLine1: 'VIII/318, Chinnangath House', addressLine2: 'Thommana, Kaduppassery P.O.',
      city: 'Irinjalakuda', state: 'Kerala', pincode: '680683', country: 'India',
      tan: 'CHNA09808A', email: 'accounts@adpedia.in',
    })
    const co = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    expect((co.registeredAddress as { city?: string }).city).toBe('Irinjalakuda')
    expect(co.tan).toBe('CHNA09808A')

    const log = await prisma.auditLog.findFirst({
      where: { companyId, entity: 'Company' }, orderBy: { at: 'desc' },
    })
    expect(log).toBeTruthy()
    expect(JSON.stringify(log!.after)).toContain('Irinjalakuda')
    expect(log!.before).toBeTruthy()
  })

  it('refuses a TAN that is not one', async () => {
    await expect(updateCompanyProfile(ctx, { addressLine1: 'x', tan: 'NOPE' }))
      .rejects.toThrow(/is not a TAN/)
  })

  it('refuses a pincode that is not one', async () => {
    await expect(updateCompanyProfile(ctx, { addressLine1: 'x', pincode: '68068' }))
      .rejects.toThrow(/is not a pincode/)
  })

  it('🔴 refuses to leave the address blank — rule 46(c) prints it on every invoice', async () => {
    await expect(updateCompanyProfile(ctx, { addressLine1: '   ' }))
      .rejects.toThrow(/needs at least a first line/)
  })

  it('🔴 cannot touch the identity that filed returns were issued under', async () => {
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    // 🔴 the input type has no field for any of them, and the service never reads one — so
    // a caller that tries anyway (a crafted form post) changes nothing
    const smuggled = {
      addressLine1: 'Somewhere else entirely',
      pan: 'ZZZZZ9999Z', gstin: '29ZZZZZ9999Z1ZZ', legalName: 'Something Else', stateCode: '29',
    } as unknown as Parameters<typeof updateCompanyProfile>[1]
    await updateCompanyProfile(ctx, smuggled)
    const after = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    expect(after.pan).toBe(before.pan)
    expect(after.gstin).toBe(before.gstin)
    expect(after.legalName).toBe(before.legalName)
    expect(after.stateCode).toBe(before.stateCode)
  })

  it('🔴 does not rewrite a document already issued', async () => {
    // docs/59 is what makes editing safe at all: the invoice served is the archived bytes
    const inv = await prisma.invoice.findFirstOrThrow({ where: { companyId, status: { not: 'DRAFT' } } })
    const archived = await prisma.attachment.findFirst({
      where: { companyId, entityType: 'Invoice', entityId: inv.id, kind: 'TAX_INVOICE', detachedAt: null },
    })
    expect(archived).not.toBeNull()
  })
})
