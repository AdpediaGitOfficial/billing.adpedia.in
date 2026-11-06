import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { createVendor } from '@/server/services/purchases/vendor'
import { previewBill, createBill, approveBill } from '@/server/services/purchases/bill'
import type { RequestContext } from '@/server/context'

/**
 * docs/89 — a vendor's GST on a bill booked by an entity with no GST registration.
 *
 * 🔴 `postVendorBill` debits 1210–1230 as a recoverable asset whenever `itcEligible`, and
 * `previewBill` set that from the VENDOR's GSTIN alone. For the personal account that put
 * tax into an asset it can never utilise: s.16(1) gives credit to a registered person.
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext
let gstVendorB = '', foreignB = '', gstVendorA = ''
const DATE = '2026-11-06'
const lines = [{ description: 'Hosting', quantity: '1', rate: '10000', gstRatePct: '18', expenseAccountCode: '5210' }]

async function journal(billId: string) {
  const entries = await prisma.journalEntry.findMany({
    where: { sourceId: billId, sourceType: { in: ['VENDOR_BILL', 'SELF_INVOICE'] } },
    include: { lines: { include: { account: true } } },
  })
  return entries.flatMap((e) => e.lines.map((l) => ({
    src: e.sourceType, code: l.account.code, dr: Number(l.debit), cr: Number(l.credit),
  })))
}

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }
  const b = await createCompany(ctxA, {
    legalName: 'A PERSONAL ACCOUNT', constitution: 'PROPRIETORSHIP',
    pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'PA',
    address: { line1: 'Thommana', city: 'Thrissur', pincode: '680683' },
    signatoryName: 'The Proprietor', signatoryDesignation: 'Proprietor',
    email: 'proprietor@example.com', phone: '9000000000',
  })
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }

  const gst = { name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR' as const, country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F' }
  gstVendorA = (await createVendor(ctxA, gst)).id
  gstVendorB = (await createVendor(ctxB, gst)).id
  foreignB = (await createVendor(ctxB, { name: 'DigitalOcean LLC', vendorType: 'CLOUD', country: 'US' })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('a bill from a GST-registered vendor, booked by an unregistered entity', () => {
  it('the GST is part of the cost: no input credit is previewed, stored or posted', async () => {
    const p = await previewBill(ctxB, { vendorId: gstVendorB, billNumber: 'U-1', billDate: DATE, lines })
    expect(p.registered).toBe(false)
    expect(p.itcEligible).toBe(false)
    expect(p.grandTotal.toFixed(2)).toBe('11800.00')
    expect(p.warnings.join(' ')).toMatch(/not registered for GST.*part of its cost/)

    const bill = await createBill(ctxB, { vendorId: gstVendorB, billNumber: 'U-1', billDate: DATE, lines })
    expect(bill.itcEligible).toBe(false)
    expect(bill.itcBlockedReason).toMatch(/not registered for GST/)
    await approveBill(ctxB, bill.id)

    const j = await journal(bill.id)
    // nothing in the input-credit accounts…
    expect(j.filter((l) => ['1210', '1220', '1230', '1240'].includes(l.code))).toEqual([])
    // …the whole 11,800 lands in the expense, and the vendor is owed all of it
    expect(j.find((l) => l.code === '5210')?.dr).toBe(11800)
    expect(j.find((l) => l.code === '2000')?.cr).toBe(11800)
  })

  it('refuses a claim for credit outright, as an expense does', async () => {
    await expect(previewBill(ctxB, { vendorId: gstVendorB, billNumber: 'U-2', billDate: DATE, itcEligible: true, lines }))
      .rejects.toThrow(/no input credit to claim/)
  })

  it('does not self-account reverse charge for a foreign vendor, and says why', async () => {
    const p = await previewBill(ctxB, { vendorId: foreignB, billNumber: 'U-3', billDate: DATE, lines })
    expect(p.rcmIgst.toFixed(2)).toBe('0.00')
    expect(p.warnings.join(' ')).toMatch(/not registered for GST.*reverse charge/)

    const bill = await createBill(ctxB, { vendorId: foreignB, billNumber: 'U-3', billDate: DATE, lines })
    expect(bill.isRcm).toBe(false)
    const approved = await approveBill(ctxB, bill.id)
    expect(approved.selfInvoiceNo).toBeNull()
    const j = await journal(bill.id)
    expect(j.some((l) => l.src === 'SELF_INVOICE' || l.code === '1240' || l.code === '2140')).toBe(false)
  })
})

describe('the registered company is unchanged', () => {
  it('still claims the vendor’s GST as input credit', async () => {
    const p = await previewBill(ctxA, { vendorId: gstVendorA, billNumber: 'R-1', billDate: DATE, lines })
    expect(p.registered).toBe(true)
    expect(p.itcEligible).toBe(true)
    const bill = await createBill(ctxA, { vendorId: gstVendorA, billNumber: 'R-1', billDate: DATE, lines })
    await approveBill(ctxA, bill.id)
    const j = await journal(bill.id)
    expect(j.find((l) => l.code === '1210')?.dr).toBe(900)
    expect(j.find((l) => l.code === '1220')?.dr).toBe(900)
    expect(j.find((l) => l.code === '5210')?.dr).toBe(10000)
  })
})
