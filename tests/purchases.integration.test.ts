import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createVendor, deriveRcm } from '@/server/services/purchases/vendor'
import { previewBill, createBill, approveBill, payBill, cancelBill } from '@/server/services/purchases/bill'
import { createExpense } from '@/server/services/purchases/expense'
import { apSummary, tdsPayableSummary } from '@/server/services/purchases/payables'
import { gstPosition } from '@/server/services/tax/gst-ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let freelancer = '', exalture = '', digitalOcean = '', afrizon = '', noPan = ''
const DATE = '2026-08-10'
const FROM = new Date('2026-07-01'), TO = new Date('2026-09-30T23:59:59Z')

const lines = (rate: string, account = '5210') => [
  { description: 'Development work', sacCode: '998314', quantity: '1', rate, gstRatePct: '18', expenseAccountCode: account },
]

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  freelancer   = (await createVendor(ctx, { name: 'Akash Raveendran', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', pan: 'ABCPD1234E', defaultTdsSection: '194J' })).id
  exalture     = (await createVendor(ctx, { name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C' })).id
  digitalOcean = (await createVendor(ctx, { name: 'DigitalOcean LLC', vendorType: 'CLOUD', country: 'US' })).id
  afrizon      = (await createVendor(ctx, { name: 'Afrizon Crenergy Trade Pte', vendorType: 'OTHER', country: 'SG', defaultTdsSection: '195' })).id
  noPan        = (await createVendor(ctx, { name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', defaultTdsSection: '194J' })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('vendor master', () => {
  it('derives reverse charge from the absence of an Indian GSTIN', () => {
    expect(deriveRcm('IN', '32AABCE1234F1Z5')).toEqual({ isForeignSupplier: false, rcmApplicable: false })
    expect(deriveRcm('US', null)).toEqual({ isForeignSupplier: true, rcmApplicable: true })
    // AWS India bills with a GSTIN, so no RCM even though the brand is foreign
    expect(deriveRcm('IN', '27AAACA1234A1Z5')).toEqual({ isForeignSupplier: false, rcmApplicable: false })
  })

  it('flags DigitalOcean for reverse charge and Exalture not', async () => {
    const dO = await prisma.vendor.findUniqueOrThrow({ where: { id: digitalOcean } })
    expect(dO.rcmApplicable).toBe(true)
    const ex = await prisma.vendor.findUniqueOrThrow({ where: { id: exalture } })
    expect(ex.rcmApplicable).toBe(false)
  })

  it('refuses s.195 on a resident and a domestic section on a non-resident', async () => {
    await expect(createVendor(ctx, { name: 'X', vendorType: 'OTHER', country: 'IN', stateCode: '32', defaultTdsSection: '195' }))
      .rejects.toThrow(/non-residents only/)
    await expect(createVendor(ctx, { name: 'Y', vendorType: 'OTHER', country: 'US', defaultTdsSection: '194J' }))
      .rejects.toThrow(/deducted under s.195/)
  })

  it('refuses a malformed PAN', async () => {
    await expect(createVendor(ctx, { name: 'Z', vendorType: 'OTHER', country: 'IN', stateCode: '32', pan: 'NOTAPAN' }))
      .rejects.toThrow(/not a valid PAN/)
  })
})

describe('TDS on a domestic bill', () => {
  it('🔴 computes on the taxable value, not the GST-inclusive total', async () => {
    const p = await previewBill(ctx, { vendorId: exalture, billNumber: 'EX/001', billDate: DATE, lines: lines('200000', '5220') })
    expect(p.taxableValue.toFixed(2)).toBe('200000.00')
    expect(p.grandTotal.toFixed(2)).toBe('236000.00')
    expect(p.tds.applies).toBe(true)
    expect(p.tds.ratePct.toFixed(2)).toBe('2.00')          // Exalture's PAN is a company -> 194C @2%
    expect(p.tds.tdsAmount.toFixed(2)).toBe('4000.00')     // 2% of 200,000, not of 236,000
    expect(p.netPayable.toFixed(2)).toBe('232000.00')
  })

  it('applies 1% for an individual and 2% for a company under 194C', async () => {
    const individual = await createVendor(ctx, { name: 'Individual Contractor', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32', pan: 'ABCPC1234E', defaultTdsSection: '194C' })
    const p = await previewBill(ctx, { vendorId: individual.id, billNumber: 'IC/001', billDate: DATE, lines: lines('200000') })
    expect(p.tds.ratePct.toFixed(2)).toBe('1.00')
  })

  it('🔴 forces 20% under s.206AA when there is no verified PAN', async () => {
    const p = await previewBill(ctx, { vendorId: noPan, billNumber: 'MU/001', billDate: DATE, lines: lines('100000') })
    expect(p.tds.ratePct.toFixed(2)).toBe('20.00')
    expect(p.tds.tdsAmount.toFixed(2)).toBe('20000.00')
    expect(p.tds.reason).toMatch(/206AA/)
    expect(p.warnings.join(' ')).toMatch(/Collect the PAN before paying/)
  })
})

describe('🔴 the retrospective threshold crossing', () => {
  it('deducts nothing while the vendor is under the annual limit', async () => {
    const b1 = await createBill(ctx, { vendorId: freelancer, billNumber: 'AK/001', billDate: DATE, lines: lines('18500') })
    await approveBill(ctx, b1.id)
    const bill = await prisma.vendorBill.findUniqueOrThrow({ where: { id: b1.id } })
    expect(bill.tdsAmount.toString()).toBe('0')
    // the section IS recorded even though nothing was deducted — a bill below the
    // threshold still counts toward it, and the cumulative lookup reads this column
    expect(bill.tdsSection).toBe('194J')
    expect(await prisma.tdsDeduction.count({ where: { documentId: b1.id } })).toBe(0)
  })

  it('warns as the headroom runs out', async () => {
    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'AK/002', billDate: DATE, lines: lines('25000') })
    expect(p.tds.applies).toBe(false)
    expect(p.warnings.join(' ')).toMatch(/headroom left/)
  })

  it('deducts on the WHOLE year when the limit is crossed, not the excess', async () => {
    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'AK/003', billDate: DATE, lines: lines('40000') })
    expect(p.tds.applies).toBe(true)
    expect(p.tds.cumulativeBefore.toFixed(2)).toBe('18500.00')
    expect(p.tds.cumulativeAfter.toFixed(2)).toBe('58500.00')
    expect(p.tds.applyOn.toFixed(2)).toBe('58500.00')      // not the 8,500 of excess
    expect(p.tds.tdsAmount.toFixed(2)).toBe('5850.00')     // 10% of the full 58,500
    expect(p.warnings.join(' ')).toMatch(/not just this bill/)

    const b = await createBill(ctx, { vendorId: freelancer, billNumber: 'AK/003', billDate: DATE, lines: lines('40000') })
    await approveBill(ctx, b.id)
    const saved = await prisma.vendorBill.findUniqueOrThrow({ where: { id: b.id } })
    expect(saved.tdsAmount.toString()).toBe('5850')
  })

  it('taxes later bills on themselves alone', async () => {
    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'AK/004', billDate: DATE, lines: lines('30000') })
    expect(p.tds.applyOn.toFixed(2)).toBe('30000.00')
    expect(p.tds.tdsAmount.toFixed(2)).toBe('3000.00')
  })
})

describe('🔴 reverse charge on an import of service', () => {
  it('nets to zero: IGST payable in cash, the same amount claimable as ITC', async () => {
    const p = await previewBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-2026-08', billDate: DATE, lines: [{ description: 'Droplets', quantity: '1', rate: '25000', expenseAccountCode: '5310' }] })
    expect(p.grandTotal.toFixed(2)).toBe('25000.00')       // the supplier charges no GST
    expect(p.cgst.plus(p.sgst).plus(p.igst).toFixed(2)).toBe('0.00')
    expect(p.rcmIgst.toFixed(2)).toBe('4500.00')           // 18% self-accounted
    expect(p.warnings.join(' ')).toMatch(/in cash, never set off against existing ITC/)

    const bill = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-2026-08', billDate: DATE, lines: [{ description: 'Droplets', quantity: '1', rate: '25000', expenseAccountCode: '5310' }] })
    const approved = await approveBill(ctx, bill.id)
    expect(approved.selfInvoiceNo).toMatch(/^ADPS\/26-27\/\d{4}$/)

    const entries = await prisma.journalEntry.findMany({
      where: { sourceId: bill.id }, include: { lines: { include: { account: true } } },
    })
    const rcm = entries.find((e) => e.sourceType === 'SELF_INVOICE')!
    const by = Object.fromEntries(rcm.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['1240']).toBe('4500.00')   // ITC on reverse charge
    expect(by['2140']).toBe('4500.00')   // RCM payable, cash only
  })

  it('shows up in the GST position as payable in cash with matching credit', async () => {
    const pos = await gstPosition(ctx.companyId, FROM, TO)
    expect(pos.rcm.payable.toFixed(2)).toBe('4500.00')
    expect(pos.rcm.itc.toFixed(2)).toBe('4500.00')
    expect(pos.cashPayable.toFixed(2)).toBe('4500.00')
  })

  it('warns that a non-resident payment needs 15CA/15CB before remittance', async () => {
    const p = await previewBill(ctx, { vendorId: afrizon, billNumber: 'AF/001', billDate: DATE, lines: [{ description: 'Consulting', quantity: '1', rate: '10000', expenseAccountCode: '5200' }] })
    expect(p.warnings.join(' ')).toMatch(/Form 15CA[\s\S]*15CB[\s\S]*BEFORE the remittance/)
    expect(p.warnings.join(' ')).toMatch(/Tax Residency Certificate/)
  })
})

describe('bill posting and payment', () => {
  it('posts a balanced entry with input GST separated out', async () => {
    const bill = await createBill(ctx, { vendorId: exalture, billNumber: 'EX/010', billDate: DATE, lines: lines('200000', '5220') })
    await approveBill(ctx, bill.id)

    const entries = await prisma.journalEntry.findMany({ where: { sourceId: bill.id }, include: { lines: { include: { account: true } } } })
    const main = entries.find((e) => e.narration.startsWith('Bill'))!
    const by = Object.fromEntries(main.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['5220']).toBe('200000.00')   // subcontract cost
    expect(by['1210']).toBe('18000.00')    // input CGST
    expect(by['1220']).toBe('18000.00')    // input SGST
    expect(by['2000']).toBe('236000.00')   // accounts payable

    const tds = entries.find((e) => e.narration.startsWith('TDS'))!
    const tdsBy = Object.fromEntries(tds.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(tdsBy['2000']).toBe('4000.00')  // AP reduced
    expect(tdsBy['2230']).toBe('4000.00')  // TDS payable — 194C
  })

  it('pays the vendor net of TDS and refuses to pay the withheld part', async () => {
    const bill = await prisma.vendorBill.findFirstOrThrow({ where: { billNumber: 'EX/010' } })
    await expect(payBill(ctx, { billId: bill.id, date: DATE, amount: '236000', mode: 'NEFT' }))
      .rejects.toThrow(/TDS of ₹4000 is withheld, not paid to the vendor/)

    await payBill(ctx, { billId: bill.id, date: DATE, amount: '232000', mode: 'NEFT', reference: 'NEFT/EX010' })
    const paid = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } })
    expect(paid.status).toBe('PAID')
    expect(paid.amountPaid.toString()).toBe('232000')
  })

  it('refuses to approve twice', async () => {
    const bill = await prisma.vendorBill.findFirstOrThrow({ where: { billNumber: 'EX/010' } })
    await expect(approveBill(ctx, bill.id)).rejects.toThrow(/already been approved/)
  })

  it('refuses a duplicate bill number for the same vendor', async () => {
    await expect(createBill(ctx, { vendorId: exalture, billNumber: 'EX/010', billDate: DATE, lines: lines('1000', '5220') }))
      .rejects.toThrow(/already has a bill numbered/)
  })
})

describe('AP ageing treats TDS as withheld, not owed', () => {
  it('shows the vendor only what they are actually owed', async () => {
    const bill = await createBill(ctx, { vendorId: exalture, billNumber: 'EX/020', billDate: DATE, lines: lines('200000', '5220') })
    await approveBill(ctx, bill.id)

    const ap = await apSummary(ctx)
    const row = ap.rows.find((r) => r.billNumber === 'EX/020')!
    expect(row.grandTotal.toFixed(2)).toBe('236000.00')
    expect(row.tdsWithheld.toFixed(2)).toBe('4000.00')
    expect(row.outstanding.toFixed(2)).toBe('232000.00')   // not 236,000
  })

  it('totals the TDS owed to the government by section', async () => {
    const t = await tdsPayableSummary(ctx)
    const sections = Object.fromEntries(t.bySection.map((s) => [s.section, s.amount.toFixed(2)]))
    expect(sections['194C']).toBe('8000.00')   // two Exalture bills at 4,000
    expect(sections['194J']).toBe('5850.00')   // the crossing bill
    expect(t.total.toFixed(2)).toBe('13850.00')
  })
})

describe('expenses and s.17(5) blocked credit', () => {
  it('claims input credit on an ordinary expense', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'INTERNET' } })
    const e = await createExpense(ctx, { categoryId: cat.id, date: DATE, description: 'Blue Light Cable Vision — August', taxableValue: '2000' })
    expect(e.itcEligible).toBe(true)
    expect(e.total.toString()).toBe('2360')

    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceId: e.id }, include: { lines: { include: { account: true } } } })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['5320']).toBe('2000.00')   // cost excludes the tax
    expect(by['1210']).toBe('180.00')
    expect(by['1220']).toBe('180.00')
  })

  it('🔴 puts blocked GST into the cost rather than pretending it is recoverable', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'TRAVEL' } })
    const e = await createExpense(ctx, {
      categoryId: cat.id, date: DATE, description: 'Client dinner', taxableValue: '4000', gstRatePct: '5',
      itcEligible: false, itcBlockedReason: 'S17_5_B_FOOD',
    })
    expect(e.itcEligible).toBe(false)
    expect(e.itcBlockedReason).toMatch(/s\.17\(5\)\(b\)/)

    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceId: e.id }, include: { lines: { include: { account: true } } } })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['5400']).toBe('4200.00')   // 4,000 + 200 of blocked tax, all cost
    expect(by['1210']).toBeUndefined()   // nothing in the ITC account
  })

  it('requires a reason before blocking the credit', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'OFFICE' } })
    await expect(createExpense(ctx, { categoryId: cat.id, date: DATE, description: 'Stationery', taxableValue: '1000', itcEligible: false }))
      .rejects.toThrow(/needs a reason/)
  })
})

describe('input credit now shows on the GST position', () => {
  it('output less input is the net payable', async () => {
    const pos = await gstPosition(ctx.companyId, FROM, TO)
    expect(pos.input.total.gt(new Decimal(0))).toBe(true)
    expect(pos.net.toFixed(2)).toBe(pos.output.total.minus(pos.input.total).toFixed(2))
  })
})

describe('cancellation reverses everything it posted', () => {
  it('reverses the bill, the TDS and the RCM self-invoice', async () => {
    const bill = await createBill(ctx, { vendorId: digitalOcean, billNumber: 'DO-2026-09', billDate: DATE, lines: [{ description: 'Droplets', quantity: '1', rate: '10000', expenseAccountCode: '5310' }] })
    await approveBill(ctx, bill.id)
    const before = await prisma.journalEntry.count({ where: { sourceId: bill.id } })
    expect(before).toBe(2)   // bill + self-invoice

    await cancelBill(ctx, bill.id, 'Duplicate of the August bill', new Date(DATE))
    const after = await prisma.journalEntry.findMany({ where: { sourceId: bill.id } })
    expect(after).toHaveLength(4)                                   // each reversed
    expect(after.filter((e) => e.reversalOfId).length).toBe(2)
    expect((await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('CANCELLED')
  })
})

describe('🔴 the offline queue cannot book an expense twice', () => {
  it('replaying the same clientKey returns the first expense and posts nothing new', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'INTERNET' } })
    const key = 'offline-key-aaaaaaaa-1111'
    const input = { categoryId: cat.id, date: DATE, description: 'Hotspot top-up at client site', taxableValue: '450', clientKey: key }

    const first = await createExpense(ctx, input)
    const replay = await createExpense(ctx, input)

    // same record, not a second one
    expect(replay.id).toBe(first.id)
    expect(await prisma.expense.count({ where: { companyId: ctx.companyId, clientKey: key } })).toBe(1)

    // and crucially no second journal entry — a duplicate would claim the input credit twice
    const entries = await prisma.journalEntry.count({ where: { sourceType: 'EXPENSE', sourceId: first.id } })
    expect(entries).toBe(1)
  })

  it('still books two genuinely different expenses that happen to look alike', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'INTERNET' } })
    const base = { categoryId: cat.id, date: DATE, description: 'Data pack', taxableValue: '100' }
    const a = await createExpense(ctx, { ...base, clientKey: 'park-one-aaaaaaaa' })
    const b = await createExpense(ctx, { ...base, clientKey: 'park-two-bbbbbbbb' })
    expect(a.id).not.toBe(b.id)
  })

  it('an expense filed with no key at all is unaffected', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: ctx.companyId, code: 'OFFICE' } })
    const a = await createExpense(ctx, { categoryId: cat.id, date: DATE, description: 'Pens', taxableValue: '50' })
    const b = await createExpense(ctx, { categoryId: cat.id, date: DATE, description: 'Pens', taxableValue: '50' })
    expect(a.id).not.toBe(b.id)
  })
})
