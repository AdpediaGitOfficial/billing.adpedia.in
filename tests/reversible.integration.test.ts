import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { recordGstPayment } from '@/server/services/tax/gst-payment'
import { recordSetOff, previewSetOff, dischargedPeriods } from '@/server/services/tax/gst-setoff'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import { cancelCreditNote, cancelGstSetOff } from '@/server/services/accounting/corrections'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { electronicLedgers } from '@/server/services/tax/gst-electronic-ledgers'
import { trialBalance } from '@/server/services/reports/statements'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const balance = async (code: string) =>
  (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

const invoice = (date: string, rate = '100000') =>
  createInvoice(ctx, {
    customerId, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }],
  }).then((d) => sendInvoice(ctx, d.id))

describe('🔴 reversing a credit note', () => {
  it('puts the ledger and the invoice back', async () => {
    const inv = await invoice('2026-05-10')
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-05-20', full: true, reason: 'Raised against the wrong invoice',
    })

    // crediting it in full marked the invoice PAID
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID')
    const arAfterCredit = await balance('1100')

    await cancelCreditNote(ctx, note.id, 'Raised against the wrong invoice', new Date('2026-05-25'))

    // 🔴 the invoice goes back to being owed — leaving it PAID would show it settled by a
    // credit note that no longer exists, and drop it out of the ageing that should chase it
    const back = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(back.status).toBe('SENT')
    expect(Number(await balance('1100'))).toBeGreaterThan(Number(arAfterCredit))
    expect(await balance('2110')).toBe(Number(inv.cgst).toFixed(2))
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('frees the invoice to be credited again', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { companyId: ctx.companyId, date: new Date('2026-05-10') } })
    const again = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-05-26', full: true, reason: 'The corrected credit note',
    })
    expect(again.grandTotal.toString()).toBe(inv.grandTotal.toString())
  })

  it('leaves the cancelled note out of GSTR-1', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2026-04-01'), new Date('2026-06-30T23:59:59Z'), '2026-Q1')
    expect(r.creditNotes).toHaveLength(1)
    expect(r.creditNotes[0].reason).toBe('The corrected credit note')
  })

  it('keeps it on file, cancelled, with its number', async () => {
    const cancelled = await prisma.creditNote.findFirstOrThrow({ where: { cancelReason: { not: null } } })
    expect(cancelled.cancelledAt).not.toBeNull()
    expect(cancelled.number).toMatch(/ADPC/)
  })

  it('🔴 refuses once the GSTR-1 that declared it is filed', async () => {
    const live = await prisma.creditNote.findFirstOrThrow({ where: { cancelledAt: null } })
    await recordGstFiling(ctx, { returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-13' })

    await expect(cancelCreditNote(ctx, live.id, 'Changed our mind about it', new Date('2026-07-20')))
      .rejects.toThrow(/reached the customer/)
  })
})

describe('🔴 reversing a GST set-off', () => {
  let setOffId = ''

  it('puts the liability and both ledgers back', async () => {
    const inv = await invoice('2026-08-12', '200000')
    expect(inv.status).toBe('SENT')

    await recordGstPayment(ctx, {
      periodLabel: '2026-Q2', paidOn: '2026-10-24',
      cin: 'IDIB000M00126102412345', cgst: '18000', sgst: '18000',
    })
    const setOff = await recordSetOff(ctx, { periodLabel: '2026-Q2', setOffOn: '2026-10-24' })
    setOffId = setOff.id

    expect(await balance('2110')).toBe('0.00')
    const ledgersBefore = await electronicLedgers(ctx, PERIOD)
    expect(ledgersBefore.cash.total.closing.toFixed(2)).toBe('0.00')

    await cancelGstSetOff(ctx, setOff.id, 'Offset the wrong period', new Date('2026-10-26'))

    // the liability is owed again and the cash is sitting in the ledger again — which is the
    // true position, because money that was never debited is still there
    expect(Number(await balance('2110'))).toBeGreaterThan(0)
    const ledgersAfter = await electronicLedgers(ctx, PERIOD)
    expect(ledgersAfter.cash.total.closing.toFixed(2)).toBe('36000.00')
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })

  it('makes the period undischarged again', async () => {
    expect(await dischargedPeriods(ctx.companyId)).not.toContain('2026-Q2')
    const p = await previewSetOff(ctx, '2026-Q2', new Date('2026-10-26'))
    expect(p.liability.cgst.gt(0)).toBe(true)
    expect(p.plan.shortfall.total.toFixed(2)).toBe('0.00')   // the cash is still there
  })

  it('can then be set off again', async () => {
    const again = await recordSetOff(ctx, { periodLabel: '2026-Q2', setOffOn: '2026-10-27' })
    expect(again.cashUsed.toString()).toBe('36000')
    expect(await balance('2110')).toBe('0.00')
  })

  it('🔴 refuses once the GSTR-3B it discharged is filed', async () => {
    await recordGstFiling(ctx, { returnType: 'GSTR3B', periodLabel: '2026-Q2', filedOn: '2026-10-24' })
    const live = await prisma.gstSetOff.findFirstOrThrow({ where: { periodLabel: '2026-Q2', cancelledAt: null } })

    await expect(cancelGstSetOff(ctx, live.id, 'Offset the wrong period', new Date('2026-10-28')))
      .rejects.toThrow(/table 6\.1 of that return/)
  })

  it('refuses a second cancellation and demands a reason', async () => {
    await expect(cancelGstSetOff(ctx, setOffId, 'bad')).rejects.toThrow(/needs a reason/)
    await expect(cancelGstSetOff(ctx, setOffId, 'Already reversed once', new Date('2026-10-28')))
      .rejects.toThrow(/already cancelled/)
  })
})
