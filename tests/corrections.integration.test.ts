import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { createExpense } from '@/server/services/purchases/expense'
import { cancelReceipt, cancelExpense } from '@/server/services/accounting/corrections'
import { trialBalance, balanceSheet } from '@/server/services/reports/statements'
import { gstPosition } from '@/server/services/tax/gst-ledger'
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
    defaultTdsSection: '194J',
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

async function openInvoice() {
  return sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-01', tdsSection: '194J',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
}

describe('🔴 cancelling a receipt puts everything back', () => {
  it('restores the invoice, reverses the ledger and frees the TDS', async () => {
    const inv = await openInvoice()
    const tbBefore = await trialBalance(ctx, { from: FROM, to: TO })

    const receipt = await createReceipt(ctx, {
      customerId, date: '2026-05-20', mode: 'NEFT',
      allocations: [{ invoiceId: inv.id, amount: '108000', tdsAmount: '10000' }],
    })
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(paid.status).toBe('PAID')

    await cancelReceipt(ctx, receipt.id, 'Allocated to the wrong invoice', new Date('2026-05-25'))

    const back = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(back.amountReceived.toString()).toBe('0')
    expect(back.tdsCredited.toString()).toBe('0')
    // 🔴 back to OVERDUE, never DRAFT — the invoice was issued and its number is out there
    expect(['SENT', 'OVERDUE']).toContain(back.status)

    // the TDS receivable is reversed, not deleted
    const tds = await prisma.tdsReceivable.findFirstOrThrow({ where: { invoiceId: inv.id } })
    expect(tds.reversedAt).not.toBeNull()

    // 🔴 and the ledger is exactly where it was before the receipt existed
    const tbAfter = await trialBalance(ctx, { from: FROM, to: TO })
    expect(tbAfter.balanced).toBe(true)
    const bankBefore = tbBefore.rows.find((r) => r.code === '1010')
    const bankAfter = tbAfter.rows.find((r) => r.code === '1010')
    expect(bankAfter?.closingDr.toFixed(2) ?? '0.00').toBe(bankBefore?.closingDr.toFixed(2) ?? '0.00')
  })

  it('keeps both entries in the journal rather than erasing one', async () => {
    const inv = await openInvoice()
    const receipt = await createReceipt(ctx, {
      customerId, date: '2026-06-01', mode: 'NEFT',
      allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })
    await cancelReceipt(ctx, receipt.id, 'Duplicate entry', new Date('2026-06-02'))

    const entries = await prisma.journalEntry.findMany({ where: { sourceType: 'RECEIPT', sourceId: receipt.id } })
    expect(entries).toHaveLength(2)
    expect(entries.filter((e) => e.reversalOfId).length).toBe(1)
  })

  it('marks the receipt cancelled and keeps its number', async () => {
    const inv = await openInvoice()
    const r = await createReceipt(ctx, {
      customerId, date: '2026-06-05', mode: 'CHEQUE',
      allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })
    await cancelReceipt(ctx, r.id, 'Cheque bounced', new Date('2026-06-06'))
    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.cancelledAt).not.toBeNull()
    expect(after.number).toBe(r.number)   // the series has no gap
  })

  it('refuses to cancel twice', async () => {
    const inv = await openInvoice()
    const r = await createReceipt(ctx, {
      customerId, date: '2026-06-10', mode: 'NEFT', allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })
    await cancelReceipt(ctx, r.id, 'Entered in error', new Date('2026-06-11'))
    await expect(cancelReceipt(ctx, r.id, 'Again', new Date('2026-06-11'))).rejects.toThrow(/already cancelled/)
  })

  it('demands a reason', async () => {
    const inv = await openInvoice()
    const r = await createReceipt(ctx, {
      customerId, date: '2026-06-12', mode: 'NEFT', allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })
    await expect(cancelReceipt(ctx, r.id, 'no', new Date('2026-06-13'))).rejects.toThrow(/needs a reason/)
  })
})

describe('🔴 TDS already matched to 26AS', () => {
  it('refuses, rather than unwinding a filed position', async () => {
    const inv = await openInvoice()
    const r = await createReceipt(ctx, {
      customerId, date: '2026-07-01', mode: 'NEFT',
      allocations: [{ invoiceId: inv.id, amount: '108000', tdsAmount: '10000' }],
    })
    await prisma.tdsReceivable.updateMany({ where: { invoiceId: inv.id }, data: { status: 'MATCHED_26AS' } })

    await expect(cancelReceipt(ctx, r.id, 'Wrong invoice', new Date('2026-07-02')))
      .rejects.toThrow(/matched to Form 26AS/)
  })
})

describe('🔴 cancelling an expense reverses its input credit', () => {
  it('unwinds the GST as well as the cost', async () => {
    const cat = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.companyId, code: 'INTERNET' },
    })
    const before = await gstPosition(ctx.companyId, FROM, TO)

    const exp = await createExpense(ctx, {
      categoryId: cat.id, date: '2026-08-01', description: 'Hotspot', taxableValue: '10000',
    })
    const during = await gstPosition(ctx.companyId, FROM, TO)
    expect(during.input.total.gt(before.input.total)).toBe(true)

    await cancelExpense(ctx, exp.id, 'Billed to the wrong company', new Date('2026-08-05'))

    // the credit goes back: claiming GST on cost that was never incurred is the real risk
    const after = await gstPosition(ctx.companyId, FROM, TO)
    expect(after.input.total.toFixed(2)).toBe(before.input.total.toFixed(2))
  })

  it('leaves the balance sheet balanced', async () => {
    const bs = await balanceSheet(ctx, TO, FROM)
    expect(bs.balanced).toBe(true)
  })
})
