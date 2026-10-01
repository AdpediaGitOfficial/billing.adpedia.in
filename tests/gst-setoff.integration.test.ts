import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { recordGstPayment, previewGstPayment } from '@/server/services/tax/gst-payment'
import { previewSetOff, recordSetOff, dischargedPeriods } from '@/server/services/tax/gst-setoff'
import { electronicLedgers } from '@/server/services/tax/gst-electronic-ledgers'
import { buildGstr3b } from '@/server/services/tax/gstr3b'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = ''
const FROM = new Date('2026-04-01'), TO = new Date('2027-03-31T23:59:59Z')
const period = { from: FROM, to: TO }

const balance = async (code: string) =>
  (await accountLedger(ctx, code, period))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id

  // Kerala customer, so the output tax is CGST 9,000 + SGST 9,000
  await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-10',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 a challan funds the cash ledger — it does not discharge anything', () => {
  it('debits the cash ledger head-wise and leaves the liability standing', async () => {
    await recordGstPayment(ctx, {
      periodLabel: '2026-Q1', paidOn: '2026-07-24',
      cin: 'IDIB000M00126072412345', cgst: '9000', sgst: '9000',
    })

    // the money is in the cash ledger, under its own major heads
    expect(await balance('1252')).toBe('9000.00')
    expect(await balance('1253')).toBe('9000.00')
    // 🔴 and the output liability is untouched. Before docs/46 the challan debited these
    // directly, so a deposit that had discharged nothing read as a settled period.
    expect(await balance('2110')).toBe('9000.00')
    expect(await balance('2120')).toBe('9000.00')
  })

  it('keeps the trial balance square', async () => {
    expect((await trialBalance(ctx, period)).balanced).toBe(true)
  })

  it('shows up on the electronic cash ledger as money in', async () => {
    const { cash } = await electronicLedgers(ctx, period)
    expect(cash.total.credited.toFixed(2)).toBe('18000.00')
    expect(cash.total.debited.toFixed(2)).toBe('0.00')
    expect(cash.total.closing.toFixed(2)).toBe('18000.00')
    expect(cash.heads.find((h) => h.label === 'CGST')!.closing.toFixed(2)).toBe('9000.00')
    expect(cash.lines.some((l) => l.narration.includes('PMT-06'))).toBe(true)
    expect(cash.notes.join(' ')).toMatch(/rule 88B\(1\)/)
  })

  it('🔴 is not "paid" as far as the calendar is concerned', async () => {
    const cal = await complianceCalendar(ctx)
    const item = cal.find((i) => i.id === 'gst-payment-2026-Q1')!
    expect(item.state).not.toBe('DONE')
    expect(item.detail).toMatch(/not set off/)
    expect(await dischargedPeriods(ctx.companyId)).not.toContain('2026-Q1')
  })
})

describe('setting off', () => {
  it('previews the discharge head by head', async () => {
    const p = await previewSetOff(ctx, '2026-Q1', new Date('2026-07-24'))
    expect(p.liability.cgst.toFixed(2)).toBe('9000.00')
    expect(p.liability.sgst.toFixed(2)).toBe('9000.00')
    expect(p.cash.cgst.toFixed(2)).toBe('9000.00')
    expect(p.plan.cash.total.toFixed(2)).toBe('18000.00')
    expect(p.plan.shortfall.total.toFixed(2)).toBe('0.00')
  })

  it('debits both ledgers and clears the liability', async () => {
    await recordSetOff(ctx, { periodLabel: '2026-Q1', setOffOn: '2026-07-24' })

    expect(await balance('2110')).toBe('0.00')
    expect(await balance('2120')).toBe('0.00')
    expect(await balance('1252')).toBe('0.00')
    expect(await balance('1253')).toBe('0.00')
    expect((await trialBalance(ctx, period)).balanced).toBe(true)
  })

  it('records what was utilised, so table 6.1 can be reproduced', async () => {
    const row = await prisma.gstSetOff.findFirstOrThrow({ where: { periodLabel: '2026-Q1' } })
    expect(row.cashCgst.toString()).toBe('9000')
    expect(row.cashSgst.toString()).toBe('9000')
    expect(row.creditUsed.toString()).toBe('0')
    expect(row.cashUsed.toString()).toBe('18000')
  })

  it('shows as a debit on the cash ledger statement', async () => {
    const { cash } = await electronicLedgers(ctx, period)
    expect(cash.total.debited.toFixed(2)).toBe('18000.00')
    expect(cash.total.closing.toFixed(2)).toBe('0.00')
    expect(cash.lines.some((l) => l.narration.includes('set-off'))).toBe(true)
  })

  it('now reads as paid on the calendar', async () => {
    const cal = await complianceCalendar(ctx)
    expect(cal.find((i) => i.id === 'gst-payment-2026-Q1')!.state).toBe('DONE')
  })

  it('refuses a second set-off for the same period', async () => {
    // the liability is gone, and the engine must not invent one to discharge
    await expect(recordSetOff(ctx, { periodLabel: '2026-Q1', setOffOn: '2026-07-25' }))
      .rejects.toThrow(/Nothing to set off/)
  })

  it('🔴 refuses to overdraw the cash ledger', async () => {
    await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2026-08-12',
      lines: [{ description: 'Design retainer', sacCode: '998391', quantity: '1', rate: '50000', gstRatePct: '18' }],
    })).id)

    await expect(recordSetOff(ctx, { periodLabel: '2026-Q2', setOffOn: '2026-10-24' }))
      .rejects.toThrow(/short for 2026-Q2/)
    const p = await previewSetOff(ctx, '2026-Q2', new Date('2026-10-24'))
    expect(p.plan.shortfall.cgst.toFixed(2)).toBe('4500.00')
    expect(p.plan.notes.join(' ')).toMatch(/A challan is needed/)
  })
})

describe('credit is used before cash, head-wise', () => {
  it('consumes the credit ledger and asks for only the balance in cash', async () => {
    // an Exalture bill gives 2,700 of input CGST and 2,700 of input SGST in Q2
    const vendor = await createVendor(ctx, {
      name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
      gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
    })
    await approveBill(ctx, (await createBill(ctx, {
      vendorId: vendor.id, billNumber: 'EX/100', billDate: '2026-08-20',
      lines: [{ description: 'Subcontract', sacCode: '998314', quantity: '1', rate: '30000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })).id)

    const p = await previewSetOff(ctx, '2026-Q2', new Date('2026-10-24'))
    expect(p.credit.cgst.toFixed(2)).toBe('2700.00')
    expect(p.plan.credit.cgstToCgst.toFixed(2)).toBe('2700.00')
    // 4,500 of CGST liability, 2,700 of credit — so 1,800 in cash, not 4,500
    expect(p.plan.shortfall.cgst.toFixed(2)).toBe('1800.00')

    const d = await previewGstPayment(ctx, '2026-Q2', new Date('2026-10-24'))
    expect(d.deposit.cgst.toFixed(2)).toBe('1800.00')
    expect(d.deposit.sgst.toFixed(2)).toBe('1800.00')
    expect(d.deposit.igst.toFixed(2)).toBe('0.00')
  })

  it('posts the credit utilisation against the input-tax accounts', async () => {
    await recordGstPayment(ctx, {
      periodLabel: '2026-Q2', paidOn: '2026-10-24',
      cin: 'IDIB000M00126102412345', cgst: '1800', sgst: '1800',
    })
    await recordSetOff(ctx, { periodLabel: '2026-Q2', setOffOn: '2026-10-24' })

    // input credit consumed, output liability clear, cash ledger emptied again
    expect(await balance('1210')).toBe('0.00')
    expect(await balance('1220')).toBe('0.00')
    expect(await balance('2110')).toBe('0.00')
    expect(await balance('1252')).toBe('0.00')
    expect((await trialBalance(ctx, period)).balanced).toBe(true)

    const row = await prisma.gstSetOff.findFirstOrThrow({ where: { periodLabel: '2026-Q2' } })
    expect(row.creditCgstToCgst.toString()).toBe('2700')
    expect(row.cashCgst.toString()).toBe('1800')
  })
})

describe('🔴 interest runs to the date of debit — rule 88B(1)', () => {
  it('warns when the ledger is funded early and set off late', async () => {
    await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2026-11-05',
      lines: [{ description: 'Film production', sacCode: '998387', quantity: '1', rate: '100000', gstRatePct: '18' }],
    })).id)
    await recordGstPayment(ctx, {
      periodLabel: '2026-Q3', paidOn: '2027-01-20',
      cin: 'IDIB000M00127012012345', cgst: '9000', sgst: '9000',
    })

    // funded four days before the deadline, offset a month after it
    const onTime = await previewSetOff(ctx, '2026-Q3', new Date('2027-01-24'))
    expect(onTime.interestToDate.interest.toFixed(2)).toBe('0.00')

    const late = await previewSetOff(ctx, '2026-Q3', new Date('2027-02-23'))
    expect(late.interestToDate.days).toBe(30)
    // 18,000 × 18% × 30/365
    expect(late.interestToDate.interest.toFixed(2)).toBe('266.30')
    expect(late.warnings.join(' ')).toMatch(/rule 88B\(1\)/)
    expect(late.warnings.join(' ')).toMatch(/did not stop the clock/)
  })
})

describe('🔴 a blank amount field is zero, not a crash', () => {
  it('accepts a challan that fills one head and leaves the rest empty', async () => {
    // how the form is actually used: an IGST-only challan leaves CGST and SGST blank. Those
    // arrive as empty strings, and `new Decimal('')` throws an error no handler recognises —
    // the screen said only "could not record that payment".
    const c = await recordGstPayment(ctx, {
      periodLabel: '2026-Q3', paidOn: '2026-12-01', cin: 'IDIB000M00126120112345',
      igst: '1000', cgst: '', sgst: '', rcm: '', interest: '', lateFee: '',
    })
    expect(c.amount.toString()).toBe('1000')
    expect(c.cgst.toString()).toBe('0')
  })

  it('says which value it could not read', async () => {
    await expect(recordGstPayment(ctx, {
      periodLabel: '2026-Q3', paidOn: '2026-12-01', cin: 'IDIB000M00126120199999', igst: 'nine thousand',
    })).rejects.toThrow(/is not an amount a challan can carry/)
  })
})

describe('🔴 GSTR-3B table 6.1 is head-wise', () => {
  it('asks for cash on SGST while CGST credit sits idle', async () => {
    // Q4 has only interstate purchases against a Kerala sale: the CGST pot fills and the
    // SGST liability cannot touch it. Netting the totals would say nothing is payable.
    const vendor = await createVendor(ctx, {
      name: 'Kerala Studio Rentals', vendorType: 'OTHER', country: 'IN', stateCode: '32',
      gstin: '32AAACK1234K1Z5', pan: 'AAACK1234K',
    })
    await approveBill(ctx, (await createBill(ctx, {
      vendorId: vendor.id, billNumber: 'KSR/1', billDate: '2027-02-10',
      lines: [{ description: 'Studio hire', sacCode: '998387', quantity: '1', rate: '60000', gstRatePct: '18', expenseAccountCode: '5500' }],
    })).id)
    await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2027-02-15',
      lines: [{ description: 'Production', sacCode: '998387', quantity: '1', rate: '40000', gstRatePct: '18' }],
    })).id)

    const r = await buildGstr3b(ctx.companyId, new Date('2027-01-01'), new Date('2027-03-31T23:59:59Z'), '2027-Q4')
    // 3,600 of CGST liability against 5,400 of CGST credit, and the same on SGST, so this
    // period genuinely nets out — the point is that each head is shown on its own
    expect(r.payable.byHead.cgst.byCredit.toFixed(2)).toBe('3600.00')
    expect(r.payable.byHead.sgst.byCredit.toFixed(2)).toBe('3600.00')
    expect(r.payable.byHead.cgst.inCash.toFixed(2)).toBe('0.00')
    expect(r.payable.strandedCredit.cgst.toFixed(2)).toBe('1800.00')
    expect(r.payable.strandedCredit.sgst.toFixed(2)).toBe('1800.00')
  })
})
