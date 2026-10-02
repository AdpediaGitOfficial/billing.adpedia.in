import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { previewAmendment, recordAmendment, amendmentDeadline } from '@/server/services/tax/gst-amendment'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { gstr1ToCsv } from '@/server/services/tax/gst-export'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, kerala = '', karnataka = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const balance = async (code: string) =>
  (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  kerala = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
  // 🔴 the state code is WRONG on the customer record — Zeta Labs are in Karnataka. This is
  // the real shape of the error the amendment exists to correct: everything downstream
  // derives from it, so the invoice comes out intra-state and Kerala is paid tax it is not
  // owed.
  karnataka = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Zeta Labs Private Limited', country: 'IN', stateCode: '32',
    gstin: '29AABCZ1234Z1Z5', customerType: 'B2B', paymentTermDays: 30, billingAddress: {},
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

const invoice = (customerId: string, date: string, rate = '100000') =>
  createInvoice(ctx, {
    customerId, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }],
  }).then((d) => sendInvoice(ctx, d.id))

describe('the s.37(3) deadline', () => {
  it('is 30 November following the financial year of supply', () => {
    expect(amendmentDeadline(new Date('2026-05-15')).toISOString().slice(0, 10)).toBe('2027-11-30')
    // 🔴 a March supply is in the SAME financial year as the previous April
    expect(amendmentDeadline(new Date('2027-03-15')).toISOString().slice(0, 10)).toBe('2027-11-30')
  })
})

describe('🔴 amending the tax head — the correction that moves money without changing the value', () => {
  let invoiceId = '', invoiceNumber = ''

  it('previews CGST and SGST out, IGST in, for the same rupees', async () => {
    // the value is right and the tax has been paid to the wrong government
    const sent = await invoice(karnataka, '2026-05-10')
    invoiceId = sent.id
    invoiceNumber = sent.number

    const p = await previewAmendment(ctx, {
      invoiceId: sent.id, date: '2026-08-10', stateCode: '29',
      reason: 'Place of supply keyed as Kerala; the recipient is in Karnataka',
    })

    expect(p.original.taxMode).toBe('INTRA')
    expect(p.revised.taxMode).toBe('INTER')
    expect(p.revised.igst.toFixed(2)).toBe('18000.00')
    expect(p.revised.cgst.toFixed(2)).toBe('0.00')
    // the invoice value does not move by a rupee
    expect(p.delta.receivable.toFixed(2)).toBe('0.00')
    expect(p.delta.cgst.toFixed(2)).toBe('-9000.00')
    expect(p.delta.igst.toFixed(2)).toBe('18000.00')
    expect(p.warnings.join(' ')).toMatch(/moves the tax between heads/)
  })

  it('posts only the difference, in the amendment period', async () => {
    const cgstBefore = await balance('2110')
    await recordAmendment(ctx, {
      invoiceId, date: '2026-08-10', stateCode: '29',
      reason: 'Place of supply keyed as Kerala; the recipient is in Karnataka',
    })

    expect(Number(await balance('2110'))).toBe(Number(cgstBefore) - 9000)
    expect(await balance('2130')).toBe('18000.00')
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)

    // 🔴 the entry is dated in the amendment period, not in the invoice's own month, which is
    // locked by the return that reported it
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.companyId, sourceType: 'GST_AMENDMENT' },
    })
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-08-10')
  })

  it('reports it in table 9A of the amendment period, not of the original', async () => {
    const q2 = await buildGstr1(ctx.companyId, new Date('2026-07-01'), new Date('2026-09-30T23:59:59Z'), '2026-Q2')
    expect(q2.amendedInvoices).toHaveLength(1)
    expect(q2.amendedInvoices[0].originalNumber).toBe(invoiceNumber)
    expect(q2.amendedInvoices[0].originalPeriod).toBe('2026-Q1')
    expect(q2.amendedInvoices[0].igst.toFixed(2)).toBe('18000.00')
    expect(q2.amendedInvoices[0].placeOfSupply).toBe('29')   // the state code, as b2b reports it
    expect(q2.warnings.join(' ')).toMatch(/table 9A/)

    // the original row stays exactly as it was filed
    const q1 = await buildGstr1(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'), '2026-Q1')
    expect(q1.amendedInvoices).toHaveLength(0)
    expect(q1.b2b.find((b) => b.invoiceNumber === invoiceNumber)!.cgst.toFixed(2)).toBe('9000.00')
  })

  it('puts the amendment in the CSV the CA files from', async () => {
    const csv = gstr1ToCsv(await buildGstr1(ctx.companyId, new Date('2026-07-01'), new Date('2026-09-30T23:59:59Z'), '2026-Q2'))
    expect(csv).toContain('b2ba — Amended B2B invoices (table 9A)')
    expect(csv).toContain(invoiceNumber)
    expect(csv).toContain('2026-Q1')
  })

  it('amends from the amended state, not from the original, the second time', async () => {
    const p = await previewAmendment(ctx, {
      invoiceId, date: '2026-11-10', taxableValue: '90000',
      reason: 'Rate corrected after the second amendment',
    })
    expect(p.original.taxMode).toBe('INTER')          // what the last amendment said
    expect(p.original.igst.toFixed(2)).toBe('18000.00')
    expect(p.revised.igst.toFixed(2)).toBe('16200.00')
    expect(p.delta.igst.toFixed(2)).toBe('-1800.00')
  })
})

describe('what an amendment refuses', () => {
  it('refuses when nothing is different', async () => {
    const inv = await invoice(kerala, '2026-05-20')
    await expect(recordAmendment(ctx, { invoiceId: inv.id, date: '2026-08-20', reason: 'No change at all' }))
      .rejects.toThrow(/Nothing is different/)
  })

  it('🔴 refuses an amendment in the invoice’s own period', async () => {
    // there is nothing to amend yet — correct the invoice instead
    const inv = await invoice(kerala, '2026-05-21')
    await expect(recordAmendment(ctx, {
      invoiceId: inv.id, date: '2026-06-01', taxableValue: '90000', reason: 'Still in the same quarter',
    })).rejects.toThrow(/belongs in a later return/)
  })

  it('🔴 refuses once the s.37(3) deadline has passed', async () => {
    const inv = await invoice(kerala, '2026-05-22')
    await expect(recordAmendment(ctx, {
      invoiceId: inv.id, date: '2027-12-05', taxableValue: '90000', reason: 'Long past the deadline',
    })).rejects.toThrow(/passed on 2027-11-30/)
  })

  it('refuses a reason under five characters', async () => {
    const inv = await invoice(kerala, '2026-05-23')
    await expect(recordAmendment(ctx, { invoiceId: inv.id, date: '2026-08-23', taxableValue: '90000', reason: 'typo' }))
      .rejects.toThrow(/needs a reason/)
  })
})

describe('a value amendment', () => {
  it('moves revenue, tax and the receivable together', async () => {
    const inv = await invoice(kerala, '2026-06-05', '50000')
    await recordGstFiling(ctx, { returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-13' })

    const arBefore = await balance('1100')
    const revenueBefore = await balance('4010')

    await recordAmendment(ctx, {
      invoiceId: inv.id, date: '2026-09-15', taxableValue: '60000',
      reason: 'Billed one day short of the agreed period',
    })

    expect(Number(await balance('1100'))).toBeCloseTo(Number(arBefore) + 11800, 2)
    expect(Number(await balance('4010'))).toBeCloseTo(Number(revenueBefore) + 10000, 2)
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('🔴 is possible even though the period is locked by the filing', async () => {
    // the whole point: the invoice's own month is closed to posting, and the amendment is
    // not posted there — it is posted in the period that reports it
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: ctx.companyId, label: '2026-27' } })
    expect(fy.lockedUpTo).not.toBeNull()
    expect(fy.lockedUpTo!.toISOString().slice(0, 10)).toBe('2026-06-30')
  })
})
