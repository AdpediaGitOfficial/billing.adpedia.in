import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createAdvanceReceipt } from '@/server/services/sales/advance'
import { createRefundVoucher, advanceAvailable } from '@/server/services/sales/refund'
import { cancelReceipt, cancelRefundVoucher } from '@/server/services/accounting/corrections'
import { accountLedger } from '@/server/services/reports/ledger'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { periodFor } from '@/server/services/tax/periods'
import type { RequestContext } from '@/server/context'

/**
 * docs/69 — a refund voucher posted under the advance's identity.
 *
 * `createRefundVoucher` filed its journal entry as `sourceType: 'RECEIPT'` against the
 * RECEIPT's id, because `SourceType` had no member of its own. Two things followed, and this
 * file is the proof of both.
 */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', fyId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const balance = async (code: string) => (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)

async function anAdvance(amount = '118000', date = '2026-05-05') {
  const customer = await prisma.customer.create({
    data: { companyId, name: `Client ${Math.random().toString(36).slice(2, 8)}`, country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })
  return createAdvanceReceipt(ctx, {
    customerId: customer.id, date, amount, mode: 'NEFT', gstRatePct: '18',
    description: 'Advance for a brand film',
  })
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId } })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 a refund voucher has a journal entry of its own', () => {
  it('files it under REFUND_VOUCHER and its own id, not the advance it refunds', async () => {
    const adv = await anAdvance()
    const v = await createRefundVoucher(ctx, {
      receiptId: adv.id, date: '2026-06-01', amount: '118000', reason: 'Project cancelled before it started',
    })

    const own = await prisma.journalEntry.findMany({
      where: { companyId, sourceType: 'REFUND_VOUCHER', sourceId: v.id },
    })
    expect(own).toHaveLength(1)

    // and nothing of the refund is filed against the receipt
    const onReceipt = await prisma.journalEntry.findMany({
      where: { companyId, sourceType: 'RECEIPT', sourceId: adv.id },
    })
    expect(onReceipt).toHaveLength(1)
    expect(onReceipt[0].narration).not.toMatch(/Refund voucher/)
  })

  /**
   * 🔴 The bug this was found by.
   *
   * `cancelReceipt` reverses every entry filed under the receipt's id. While the refund's
   * entry was one of them, cancelling a refunded advance also silently reversed the refund:
   * the money went back into the bank and the liability back into 2400, while the
   * `RefundVoucher` row stayed live and kept being reported in GSTR-1 table 11B. The books
   * said the refund never happened and the return said it did.
   *
   * The answer is not to reverse it more carefully. A refund voucher went to the customer
   * under rule 51 — so cancelling the advance behind it is refused, and names the voucher.
   */
  it('🔴 refuses to cancel an advance that has been refunded, and says which voucher', async () => {
    const adv = await anAdvance('59000', '2026-05-06')
    const v = await createRefundVoucher(ctx, {
      receiptId: adv.id, date: '2026-06-02', amount: '59000', reason: 'Client withdrew the brief',
    })

    await expect(cancelReceipt(ctx, adv.id, 'Advance recorded against the wrong client', new Date('2026-06-03')))
      .rejects.toThrow(new RegExp(`${v.number}`))
    await expect(cancelReceipt(ctx, adv.id, 'Advance recorded against the wrong client', new Date('2026-06-03')))
      .rejects.toThrow(/cancel it first/)

    // and nothing moved while it refused
    const live = await prisma.receipt.findUniqueOrThrow({ where: { id: adv.id } })
    expect(live.cancelledAt).toBeNull()
  })

  it('cancels the voucher, and the receipt then cancels cleanly', async () => {
    const adv = await anAdvance('23600', '2026-05-07')
    const bankWithAdvance = await balance('1010')

    const v = await createRefundVoucher(ctx, {
      receiptId: adv.id, date: '2026-06-04', amount: '23600', reason: 'Shoot cancelled by the client',
    })
    expect(Number(await balance('1010'))).toBeCloseTo(Number(bankWithAdvance) - 23600, 2)

    await cancelRefundVoucher(ctx, v.id, 'Raised against the wrong advance', new Date('2026-06-05'))

    // the money is back where it was, the advance is whole again, and the return drops it
    expect(Number(await balance('1010'))).toBeCloseTo(Number(bankWithAdvance), 2)
    expect((await advanceAvailable(ctx.companyId, adv.id)).available.toFixed(2)).toBe('23600.00')

    const g = await buildGstr1(companyId, PERIOD.from, PERIOD.to, 'FY 2026-27')
    expect(g.advancesRefunded.some((r) => r.number === v.number)).toBe(false)

    await cancelReceipt(ctx, adv.id, 'Advance recorded against the wrong client', new Date('2026-06-06'))
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: adv.id } })).cancelledAt).not.toBeNull()
  })

  it('refuses twice, and demands a reason', async () => {
    const adv = await anAdvance('11800', '2026-05-08')
    const v = await createRefundVoucher(ctx, {
      receiptId: adv.id, date: '2026-06-07', amount: '11800', reason: 'Brief withdrawn',
    })
    await expect(cancelRefundVoucher(ctx, v.id, '  ', new Date('2026-06-08'))).rejects.toThrow()
    await cancelRefundVoucher(ctx, v.id, 'Duplicate of an earlier voucher', new Date('2026-06-08'))
    await expect(cancelRefundVoucher(ctx, v.id, 'Again', new Date('2026-06-08')))
      .rejects.toThrow(/already cancelled/)
  })
})

/**
 * 🔴 The refusal has to give the RIGHT reason — docs/61 §2's lesson in a different place.
 *
 * A credit note is refused after filing because it reached the customer's GSTR-2B. A refund
 * voucher never does: table 11B adjusts the supplier's own advances and has no counterpart on
 * the recipient's side. Saying otherwise sends somebody to ask the client about a document
 * the client has never seen in a return.
 */
describe('🔴 once the GSTR-1 that declared it is filed', () => {
  it('refuses, and says the tax would go back into a closed period', async () => {
    const adv = await anAdvance('11800', '2026-05-09')
    const v = await createRefundVoucher(ctx, {
      receiptId: adv.id, date: '2026-07-10', amount: '11800', reason: 'Project shelved',
    })

    // 🔴 Kerala is a QRMP quarterly filer (docs/00 §2), so the period that declared a July
    // voucher is the quarter, not the month. Ask `periodFor` rather than assuming.
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    const period = periodFor(new Date('2026-07-10'), company.gstFilingFrequency)
    await prisma.gstReturnPeriod.create({
      data: {
        companyId, financialYearId: fyId, periodLabel: period.label, returnType: 'GSTR1',
        status: 'FILED', filedOn: new Date('2026-11-11'),
      },
    })

    await expect(cancelRefundVoucher(ctx, v.id, 'Raised in error', new Date('2026-11-20')))
      .rejects.toThrow(/table 11B/)
    await expect(cancelRefundVoucher(ctx, v.id, 'Raised in error', new Date('2026-11-20')))
      .rejects.toThrow(/closed/)
    // and NOT the credit note's reason
    await expect(cancelRefundVoucher(ctx, v.id, 'Raised in error', new Date('2026-11-20')))
      .rejects.not.toThrow(/GSTR-2B/)
  })
})
