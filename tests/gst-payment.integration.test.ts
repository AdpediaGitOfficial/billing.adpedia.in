import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { recordGstPayment, previewGstPayment, paidPeriods } from '@/server/services/tax/gst-payment'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = ''
const FROM = new Date('2026-04-01'), TO = new Date('2027-03-31T23:59:59Z')

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id

  await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-10',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('previewing what is payable', () => {
  it('reads the cash liability off the return and dates it from the deadline', async () => {
    const p = await previewGstPayment(ctx, '2026-Q1', new Date('2026-07-24'))
    expect(p.periodLabel).toBe('2026-Q1')
    // Kerala files quarterly 3B on the 24th
    expect(p.dueOn.toISOString().slice(0, 10)).toBe('2026-07-24')
    expect(p.cashPayable.gt(0)).toBe(true)
  })

  it('warns that the return is not yet recorded as filed', async () => {
    const p = await previewGstPayment(ctx, '2026-Q1', new Date('2026-07-24'))
    expect(p.warnings.join(' ')).toMatch(/not recorded as filed/)
  })
})

describe('🔴 recording a payment', () => {
  it('refuses a challan with no CIN', async () => {
    // a CPIN means the challan was generated; only a CIN means money moved. Recording the
    // former as a payment is exactly how an unpaid liability comes to look settled.
    await expect(recordGstPayment(ctx, {
      periodLabel: '2026-Q1', paidOn: '2026-07-24', cpin: '26070012345678', cgst: '9000', sgst: '9000',
    })).rejects.toThrow(/needs its CIN/)
  })

  it('posts the liability down and the bank down', async () => {
    const challan = await recordGstPayment(ctx, {
      periodLabel: '2026-Q1', paidOn: '2026-07-24',
      cin: 'IDIB000M00126072412345', cgst: '9000', sgst: '9000',
    })
    expect(challan.amount.toString()).toBe('18000')

    const cgst = await accountLedger(ctx, '2110', { from: FROM, to: TO })
    // the invoice credited it, the payment debits it back to nil
    expect(cgst!.account.closing.toString()).toBe('0')

    const bank = await accountLedger(ctx, '1010', { from: FROM, to: TO })
    expect(bank!.lines.some((l) => l.narration.includes('GST payment'))).toBe(true)
  })

  it('leaves the trial balance square', async () => {
    expect((await trialBalance(ctx, { from: FROM, to: TO })).balanced).toBe(true)
  })

  it('🔴 books interest and late fee as COST, not as tax', async () => {
    // nobody can claim them, and burying them in the tax accounts would make the GST
    // liability look larger than it was
    await recordGstPayment(ctx, {
      periodLabel: '2026-Q2', paidOn: '2026-11-05',
      cin: 'IDIB000M00126110512345', igst: '5000', interest: '150', lateFee: '100',
    })
    const charges = await accountLedger(ctx, '5600', { from: FROM, to: TO })
    const booked = charges!.lines.filter((l) => (l.lineNarration ?? '').includes('GST interest'))
    expect(booked).toHaveLength(1)
    expect(booked[0].debit.toString()).toBe('250')
  })

  it('reports which periods are paid', async () => {
    const paid = await paidPeriods(ctx.companyId)
    expect(paid.has('2026-Q1')).toBe(true)
    expect(paid.has('2026-Q3')).toBe(false)
  })

  it('counts what has already been paid against the period', async () => {
    const p = await previewGstPayment(ctx, '2026-Q1', new Date('2026-07-24'))
    expect(p.alreadyPaid.toString()).toBe('18000')
    expect(p.outstanding.toString()).toBe('0')
  })
})
