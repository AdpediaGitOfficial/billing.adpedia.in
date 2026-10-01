import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { arAgeing } from '@/server/services/sales/receivables'
import { LutMissing } from '@/server/services/invoicing/lut'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let keralaCustomer = '', mumbaiCustomer = '', dubaiCustomer = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  const mk = (name: string, country: string, stateCode: string | null, type: 'B2B' | 'EXPORT') =>
    prisma.customer.create({ data: { companyId: company.id, name, country, stateCode, customerType: type, billingAddress: {}, paymentTermDays: 15 } })

  keralaCustomer = (await mk('Click AR Business Pvt Ltd', 'IN', '32', 'B2B')).id
  mumbaiCustomer = (await mk('Nuvé Properties Pvt Ltd', 'IN', '27', 'B2B')).id
  dubaiCustomer = (await mk('Nuvé Holdings FZ-LLC', 'AE', null, 'EXPORT')).id
})
afterAll(async () => { await prisma.$disconnect() })

const LINES = [
  { description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '70000', gstRatePct: '18' },
  { description: 'UI/UX revisions', sacCode: '998391', quantity: '2', rate: '7500', gstRatePct: '18' },
]
const today = '2026-09-30'

describe('invoice lifecycle — intra-state', () => {
  it('a draft carries no real number and posts nothing', async () => {
    const inv = await createInvoice(ctx, { customerId: keralaCustomer, date: today, tdsSection: '194J', lines: LINES })
    expect(inv.status).toBe('DRAFT')
    expect(inv.number).toMatch(/^DRAFT-/)
    expect(inv.taxMode).toBe('INTRA')
    expect(inv.grandTotal.toString()).toBe('100300')
    expect(inv.tdsAmount.toString()).toBe('8500')
    expect(inv.netPayable.toString()).toBe('91800')

    const entries = await prisma.journalEntry.count({ where: { sourceType: 'INVOICE', sourceId: inv.id } })
    expect(entries).toBe(0)   // a draft is not a transaction
  })

  it('sending allocates the number and posts a balanced entry', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, tdsSection: '194J', lines: LINES })
    const sent = await sendInvoice(ctx, draft.id)

    expect(sent.number).toMatch(/^ADP\/26-27\/\d{4}$/)
    expect(sent.status).toBe('SENT')

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'INVOICE', sourceId: draft.id }, include: { lines: { include: { account: true } } },
    })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, { d: l.debit.toString(), c: l.credit.toString() }]))
    expect(by['1100'].d).toBe('100300')     // AR
    expect(by['2110'].c).toBe('7650')       // Output CGST
    expect(by['2120'].c).toBe('7650')       // Output SGST
    expect(by['2130']).toBeUndefined()      // no IGST

    const debit = entry.lines.reduce((a, l) => a.plus(l.debit.toString()), new Decimal(0))
    const credit = entry.lines.reduce((a, l) => a.plus(l.credit.toString()), new Decimal(0))
    expect(debit.toFixed(2)).toBe(credit.toFixed(2))
  })

  it('cannot be sent twice', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, lines: LINES })
    await sendInvoice(ctx, draft.id)
    await expect(sendInvoice(ctx, draft.id)).rejects.toThrow(/already been sent/)
  })
})

describe('inter-state and export', () => {
  it('a Mumbai customer gets IGST, same total', async () => {
    const inv = await createInvoice(ctx, { customerId: mumbaiCustomer, date: today, tdsSection: '194C', lines: LINES })
    expect(inv.taxMode).toBe('INTER')
    expect(inv.igst.toString()).toBe('15300')
    expect(inv.cgst.toString()).toBe('0')
    expect(inv.grandTotal.toString()).toBe('100300')
    expect(inv.tdsAmount.toString()).toBe('1700')   // 194C @2%
  })

  it('🔴 an export invoice is blocked at send because no LUT covers FY 2026-27', async () => {
    const inv = await createInvoice(ctx, { customerId: dubaiCustomer, date: today, tdsSection: '194J', lines: LINES })
    expect(inv.taxMode).toBe('EXPORT')
    expect(inv.cgst.toString()).toBe('0')
    expect(inv.igst.toString()).toBe('0')
    expect(inv.grandTotal.toString()).toBe('85000')
    expect(inv.tdsAmount.toString()).toBe('0')      // overseas clients deduct no Indian TDS

    await expect(sendInvoice(ctx, inv.id)).rejects.toThrow(LutMissing)
  })

  it('sends once a LUT for the year is filed', async () => {
    const lut = await prisma.companyLut.create({
      data: { companyId: ctx.companyId, arn: 'AD320326LIVE01', fyLabel: '2026-27',
        validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31') },
    })
    const inv = await createInvoice(ctx, { customerId: dubaiCustomer, date: today, lines: LINES })
    const sent = await sendInvoice(ctx, inv.id)
    expect(sent.number).toMatch(/^ADPX\/26-27\/\d{4}$/)
    expect(sent.lutId).toBe(lut.id)
    await prisma.companyLut.delete({ where: { id: lut.id } })
  })
})

describe('receipt with TDS, and what AR ageing then shows', () => {
  it('₹91,800 cash + ₹8,500 TDS settles a ₹1,00,300 invoice in full', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, tdsSection: '194J', lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)

    const before = (await arAgeing(ctx)).find((r) => r.invoiceId === inv.id)!
    expect(before.collectible.toFixed(2)).toBe('91800.00')   // not 100300 — TDS is not cash
    expect(before.tdsExpected.toFixed(2)).toBe('8500.00')

    await createReceipt(ctx, {
      customerId: keralaCustomer, date: today, mode: 'NEFT', reference: 'NEFT/HDFCH00822263366',
      allocations: [{ invoiceId: inv.id, amount: '91800', tdsAmount: '8500' }],
    })

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.status).toBe('PAID')
    expect(after.amountReceived.toString()).toBe('91800')
    expect(after.tdsCredited.toString()).toBe('8500')

    expect((await arAgeing(ctx)).find((r) => r.invoiceId === inv.id)).toBeUndefined()   // off the list

    const tds = await prisma.tdsReceivable.findFirstOrThrow({ where: { invoiceId: inv.id } })
    expect(tds.sectionCode).toBe('194J')
    expect(tds.tdsAmount.toString()).toBe('8500')
    expect(tds.quarter).toBe(2)       // Sep -> Q2
    expect(tds.status).toBe('BOOKED') // awaiting 26AS reconciliation

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RECEIPT' }, include: { lines: { include: { account: true } } }, orderBy: { postedAt: 'desc' },
    })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['1010']).toBe('91800.00')   // bank
    expect(by['1310']).toBe('8500.00')    // TDS receivable 194J
    expect(by['1100']).toBe('100300.00')  // AR cleared in full
  })

  it('refuses to over-allocate', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    await expect(createReceipt(ctx, {
      customerId: keralaCustomer, date: today, mode: 'NEFT',
      allocations: [{ invoiceId: inv.id, amount: '200000' }],
    })).rejects.toThrow(/exceeds its outstanding/)
  })
})

describe('cancellation', () => {
  it('keeps the number and posts a reversal', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    await cancelInvoice(ctx, inv.id, 'Raised against the wrong project', new Date(today))

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.status).toBe('CANCELLED')
    expect(after.number).toBe(inv.number)   // number retained — gaps must be explainable

    const entries = await prisma.journalEntry.findMany({ where: { sourceType: 'INVOICE', sourceId: inv.id } })
    expect(entries).toHaveLength(2)         // original + reversal
    expect(entries.some((e) => e.reversalOfId)).toBe(true)
  })

  it('refuses to cancel an invoice that has been paid', async () => {
    const draft = await createInvoice(ctx, { customerId: keralaCustomer, date: today, lines: LINES })
    const inv = await sendInvoice(ctx, draft.id)
    await createReceipt(ctx, { customerId: keralaCustomer, date: today, mode: 'NEFT', allocations: [{ invoiceId: inv.id, amount: '50000' }] })
    await expect(cancelInvoice(ctx, inv.id, 'oops')).rejects.toThrow(/credit note/)
  })
})
