import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal, ZERO } from '@/lib/money'
import { createInvoice, sendInvoice, updateInvoiceDraft, previewInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { arSummary } from '@/server/services/sales/receivables'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { outwardSupplies } from '@/server/services/tax/gst-ledger'
import { trialBalance } from '@/server/services/reports/statements'
import { clientLedger } from '@/server/services/reports/party-ledger'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

/**
 * docs/91 — USD income booked in rupees.
 *
 * 🔴 `Invoice.fxRate` defaulted to 1 and was read nowhere, so a USD 250 invoice posted ₹250 into
 * the ledger. These tests read the JOURNAL, because that is where the defect lived: the
 * invoice screen always showed the right dollars.
 */

const prisma = new PrismaClient()
let ctx: RequestContext
let customerId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const usd = (rate: string, qty = '1') => [{ description: 'Film edit', quantity: qty, rate, gstRatePct: '0', sacCode: '998397' }]

/** what 1100 holds — for this client, or for every client — the rupee control account */
async function ar(all = false) {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code: '1100' }, journalEntry: { companyId: ctx.companyId }, ...(all ? {} : { customerId }) },
  })
  return lines.reduce((a, l) => a.plus(l.debit.toString()).minus(l.credit.toString()), ZERO)
}
const lineFor = async (sourceId: string, code: string) => {
  const entries = await prisma.journalEntry.findMany({
    where: { sourceId }, include: { lines: { include: { account: true } } },
  })
  return entries.flatMap((e) => e.lines).filter((l) => l.account.code === code)
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  await prisma.companyLut.create({ data: {
    companyId: company.id, arn: 'AD320326FXTEST1', fyLabel: '2026-27',
    validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31'),
  } })
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Ahura International', country: 'CN', stateCode: null,
    customerType: 'EXPORT', currency: 'USD', paymentTermDays: 30, billingAddress: { country: 'China' },
  } })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('a foreign invoice is booked in rupees at the rate it was issued at', () => {
  let invoiceId = ''

  it('cannot be sent without a rate, and says what to enter', async () => {
    const d = await createInvoice(ctx, { customerId, date: '2026-11-02', lines: usd('250') })
    await expect(sendInvoice(ctx, d.id)).rejects.toThrow(/Enter the exchange rate for this USD invoice/)
    await prisma.invoice.delete({ where: { id: d.id } }).catch(() => {}) // lines first if needed
  })

  it('refuses a rate that is not a positive number rather than dropping it to 1', async () => {
    await expect(createInvoice(ctx, { customerId, date: '2026-11-02', fxRate: 'abc', lines: usd('250') }))
      .rejects.toThrow(/positive number/)
    await expect(createInvoice(ctx, { customerId, date: '2026-11-02', fxRate: '-5', lines: usd('250') }))
      .rejects.toThrow(/positive number/)
  })

  it('previews the rupee figure beside the dollar one', async () => {
    const p = await previewInvoice(ctx, { customerId, date: '2026-11-02', fxRate: '84.25', lines: usd('250') })
    expect(p.currency).toBe('USD')
    expect(p.inrGrandTotal).toBe('21062.50')
    const none = await previewInvoice(ctx, { customerId, date: '2026-11-02', lines: usd('250') })
    expect(none.inrGrandTotal).toBeNull()
  })

  it('🔴 USD 250 at 84.50 posts ₹21,125 to receivables and to income — not ₹250', async () => {
    const d = await createInvoice(ctx, { customerId, date: '2026-11-02', fxRate: '84.50', lines: usd('250') })
    const sent = await sendInvoice(ctx, d.id)
    invoiceId = sent.id
    // the document stays in dollars
    expect(sent.currency).toBe('USD')
    expect(Number(sent.grandTotal)).toBe(250)
    // the ledger is in rupees
    const [arLine] = await lineFor(sent.id, '1100')
    expect(Number(arLine.debit)).toBe(21125)
    const income = (await lineFor(sent.id, '4010'))[0]
    expect(Number(income.credit)).toBe(21125)
    expect((await ar()).toFixed(2)).toBe('21125.00')
  })

  it('a draft re-saved without a rate keeps the one it had; a typed rate replaces it', async () => {
    const d = await createInvoice(ctx, { customerId, date: '2026-11-03', fxRate: '84.00', lines: usd('100') })
    await updateInvoiceDraft(ctx, d.id, { customerId, date: '2026-11-03', lines: usd('120') })
    expect(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: d.id } })).fxRate)).toBe(84)
    await updateInvoiceDraft(ctx, d.id, { customerId, date: '2026-11-03', fxRate: '83.10', lines: usd('120') })
    expect(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: d.id } })).fxRate)).toBe(83.1)
  })

  it('the trial balance still balances, and the client ledger carries rupees', async () => {
    const tb = await trialBalance(ctx, PERIOD)
    expect(tb.balanced).toBe(true)
    const led = await clientLedger(ctx, customerId, PERIOD)
    expect(led!.closing.toFixed(2)).toBe('21125.00')
    // booked with a rate, so the "mixes currencies" warning no longer applies
    expect(led!.foreignCurrency).toEqual([])
  })

  describe('receipts', () => {
    it('refuses a foreign receipt that does not say what the bank credited', async () => {
      await expect(createReceipt(ctx, {
        customerId, date: '2026-11-10', mode: 'SWIFT',
        allocations: [{ invoiceId, amount: '100' }],
      })).rejects.toThrow(/Enter the rupees the bank credited/)
    })

    it('refuses a typed forex figure, TDS, and rupees on a rupee receipt', async () => {
      await expect(createReceipt(ctx, {
        customerId, date: '2026-11-10', mode: 'SWIFT', inrAmount: '8300', fxGainLoss: '10',
        allocations: [{ invoiceId, amount: '100' }],
      })).rejects.toThrow(/worked out from the rupees received/)
      await expect(createReceipt(ctx, {
        customerId, date: '2026-11-10', mode: 'SWIFT', inrAmount: '8300',
        allocations: [{ invoiceId, amount: '100', tdsAmount: '5' }],
      })).rejects.toThrow(/does not deduct Indian TDS/)
    })

    it('🔴 two part-payments at different rates clear receivables to exactly zero, the difference to forex', async () => {
      // USD 100 arrives when the dollar is weaker: ₹8,300 for ₹8,450 of receivable → loss 150
      const r1 = await createReceipt(ctx, {
        customerId, date: '2026-11-10', mode: 'SWIFT', inrAmount: '8300',
        allocations: [{ invoiceId, amount: '100' }],
      })
      expect(Number(r1.fxGainLoss)).toBe(-150)
      expect(r1.currency).toBe('USD')
      expect(Number(r1.amount)).toBe(100)
      expect(Number(r1.inrAmount)).toBe(8300)
      expect((await lineFor(r1.id, '5900'))[0].debit.toString()).toBe('150')
      expect((await ar()).toFixed(2)).toBe('12675.00')

      // the last USD 150 arrives at a better rate: ₹12,700 for ₹12,675 → gain 25
      const r2 = await createReceipt(ctx, {
        customerId, date: '2026-11-20', mode: 'SWIFT', inrAmount: '12700',
        allocations: [{ invoiceId, amount: '150' }],
      })
      expect(Number(r2.fxGainLoss)).toBe(25)
      expect((await lineFor(r2.id, '4920'))[0].credit.toString()).toBe('25')

      // nothing is left in 1100 — not even a paisa — and the invoice is paid
      expect((await ar()).toFixed(2)).toBe('0.00')
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe('PAID')

      // and the bank holds exactly what was credited
      const bank = (await lineFor(r1.id, '1010'))[0]
      expect(Number(bank.debit)).toBe(8300)
    })

    it('a rupee receipt may not carry a rupee amount, and one receipt is one currency', async () => {
      const inr = await prisma.customer.create({ data: {
        companyId: ctx.companyId, name: 'A domestic client', country: 'IN', stateCode: '32',
        customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
      } })
      const d = await createInvoice(ctx, { customerId: inr.id, date: '2026-11-05',
        lines: [{ description: 'Edit', quantity: '1', rate: '1000', gstRatePct: '18', sacCode: '998397' }] })
      const sent = await sendInvoice(ctx, d.id)
      await expect(createReceipt(ctx, {
        customerId: inr.id, date: '2026-11-12', mode: 'NEFT', inrAmount: '500',
        allocations: [{ invoiceId: sent.id, amount: '500' }],
      })).rejects.toThrow(/only for a foreign-currency receipt/)
    })
  })
})

describe('a note against a foreign invoice reverses it at the invoice\'s rate', () => {
  it('USD 50 credited on a USD 200 invoice at 84.00 takes ₹4,200 off receivables', async () => {
    const d = await createInvoice(ctx, { customerId, date: '2026-12-01', fxRate: '84.00', lines: usd('200') })
    const sent = await sendInvoice(ctx, d.id)
    const before = await ar()
    const note = await createCreditNote(ctx, {
      invoiceId: sent.id, date: '2026-12-15', reason: 'Scope reduced', taxableValue: '50',
    })
    const [arLine] = await lineFor(note.id, '1100')
    expect(Number(arLine.credit)).toBe(4200)
    expect(before.minus(await ar()).toFixed(2)).toBe('4200.00')
  })
})

describe('everything that adds invoices up speaks rupees', () => {
  it('🔴 the receivables total agrees with 1100 — dollars and rupees together', async () => {
    const summary = await arSummary(ctx)
    // a rupee invoice (₹1,180) and a USD one are both open; adding the USD figure at face
    // value would have made this 1,180 + 150 instead of 1,180 + 12,600
    expect((await ar(true)).toFixed(2)).toBe(summary.total.toFixed(2))
  })

  it('GSTR-1 reports the export in rupees, and the 3B zero-rated turnover too', async () => {
    const r = await buildGstr1(ctx.companyId, new Date('2026-11-01'), new Date('2026-11-30T23:59:59Z'), 'Nov 2026')
    const e = r.exports.find((x) => Number(x.invoiceValue) === 21125)
    expect(e).toBeTruthy()
    expect(e!.currency).toBe('USD')
    expect(e!.taxableValue.toFixed(2)).toBe('21125.00')

    const out = await outwardSupplies(ctx.companyId, new Date('2026-11-01'), new Date('2026-11-30T23:59:59Z'))
    // 21,125 for the 84.50 invoice and 120 × 83.10 for the re-saved draft is still a draft, so not here
    expect(out.zeroRated.taxable.toFixed(2)).toBe('21125.00')
  })
})
