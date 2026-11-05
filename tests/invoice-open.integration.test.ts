import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { createDebitNote } from '@/server/services/invoicing/debit-note'
import { createReceipt } from '@/server/services/sales/receipt'
import { arAgeing } from '@/server/services/sales/receivables'
import { receivablesAgeing } from '@/server/services/reports/ageing'
import { clientLedger } from '@/server/services/reports/party-ledger'
import { reconciliationQueue } from '@/server/services/banking/reconcile'
import { clientPnl } from '@/server/services/reports/client-pnl'
import { invoicesByMonth } from '@/server/services/sales/invoice-months'
import { adjustAdvance, createAdvanceReceipt } from '@/server/services/sales/advance'
import type { RequestContext } from '@/server/context'

/**
 * 🔴 docs/86 — an invoice's open amount ignored every credit and debit note against it.
 *
 * A credit note credits 1100 Accounts Receivable, so the ledger, the trial balance and the
 * client's own statement all know the client owes less. Nothing that computes "what is still
 * owed on this invoice" did: nine places subtracted `amountReceived` and `tdsCredited` from
 * `grandTotal` and stopped. The ageing, the chase list, the receipt screen and the bank
 * matcher therefore reported a debt the company itself had given back — and the receipt
 * service would accept a payment for it.
 *
 * The figures below are one invoice: ₹1,00,000 + 18% = ₹1,18,000, credited by ₹20,000 + 18%
 * = ₹23,600, leaving ₹94,400 owed.
 */

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = '', bankAccountId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id
  // 🔴 the DEFAULT account, not whichever row Postgres finds first — tests/fixture-lookups
  bankAccountId = (await prisma.companyBankAccount.findFirstOrThrow({
    where: { companyId: company.id, isDefault: true },
  })).id
})
afterAll(async () => { await prisma.$disconnect() })

const invoice = (date = '2026-05-01') => createInvoice(ctx, {
  customerId, date,
  lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
}).then((d) => sendInvoice(ctx, d.id))

/** What 1100 Accounts Receivable says this client owes — the figure every report must match. */
async function arPerLedger(): Promise<Decimal> {
  const ledger = await clientLedger(ctx, customerId, PERIOD)
  return ledger!.closing
}

describe('🔴 a credit note and the invoice that does not know about it', () => {
  it('the ledger, the ageing and the chase list agree on what is owed', async () => {
    const inv = await invoice()
    await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-01', reason: 'Deficiency in service', taxableValue: '20000',
    })

    const ledger = await arPerLedger()
    expect(ledger.toFixed(2)).toBe('94400.00')

    // 🔴 the gross the ageing works from must be the same 94,400, not the issued 1,18,000
    const [row] = (await arAgeing(ctx)).filter((r) => r.invoiceId === inv.id)
    expect(row.grandTotal.toFixed(2)).toBe('118000.00')   // the invoice as issued, unchanged
    expect(row.credited.toFixed(2)).toBe('23600.00')
    expect(row.gross.toFixed(2)).toBe('94400.00')

    // collectible is that, less the TDS the client withholds — never more than is owed
    expect(row.collectible.plus(row.tdsExpected).toFixed(2)).toBe('94400.00')

    // the other ageing report, which has its own copy of the arithmetic
    const report = await receivablesAgeing(ctx)
    const doc = report.parties.flatMap((p) => p.docs).find((d) => d.id === inv.id)!
    expect(doc.outstanding.plus(doc.tdsWithheld).toFixed(2)).toBe('94400.00')
  })

  it('the receipt service refuses the money the invoice no longer asks for', async () => {
    const inv = await invoice('2026-05-02')
    await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-02', reason: 'Deficiency in service', taxableValue: '20000',
    })

    await expect(createReceipt(ctx, {
      customerId, date: '2026-06-10', mode: 'NEFT', bankAccountId,
      allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })).rejects.toThrow(/exceeds its outstanding/)

    // and accepts what IS owed
    const r = await createReceipt(ctx, {
      customerId, date: '2026-06-10', mode: 'NEFT', bankAccountId,
      allocations: [{ invoiceId: inv.id, amount: '94400' }],
    })
    expect(r.amount.toString()).toBe('94400')
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.status).toBe('PAID')
  })

  it('the bank matcher does not offer to settle it at the issued value', async () => {
    const inv = await invoice('2026-05-03')
    await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-03', reason: 'Deficiency in service', taxableValue: '20000',
    })

    await prisma.bankTransaction.create({ data: {
      companyId: ctx.companyId, bankAccountId, txnDate: new Date('2026-06-12'),
      valueDate: new Date('2026-06-12'), amount: '94400', direction: 'CREDIT',
      rawNarration: 'NEFT CR CLICK AR BUSINESS PRIVATE LIMITED', counterpartyGuess: 'CLICK AR BUSINESS PRIVATE LIMITED',
      dedupeHash: `open-test-${inv.id}`, status: 'UNMATCHED',
    } })

    const queue = await reconciliationQueue(ctx)
    const row = queue.find((q) => q.txn.rawNarration.includes('CLICK AR'))!
    const settles = row.suggestions.find(
      (s) => s.suggestion.kind === 'RECEIPT'
        && s.suggestion.allocations.some((a) => a.invoiceId === inv.id),
    )
    // ₹94,400 is now the WHOLE invoice, so it is an exact settlement, not a part payment
    expect(settles?.tierName).toBe('Exact amount')
  })

  it('a cancelled credit note gives the debt back', async () => {
    const inv = await invoice('2026-05-04')
    const note = await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-04', reason: 'Raised against the wrong invoice', taxableValue: '20000',
    })
    const { cancelCreditNote } = await import('@/server/services/accounting/corrections')
    await cancelCreditNote(ctx, note.id, 'Raised against the wrong invoice')

    const [row] = (await arAgeing(ctx)).filter((r) => r.invoiceId === inv.id)
    expect(row.credited.toFixed(2)).toBe('0.00')
    expect(row.gross.toFixed(2)).toBe('118000.00')
  })

  it('a debit note adds to what is owed', async () => {
    const inv = await invoice('2026-05-05')
    await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-05', reason: 'Additional shoot day agreed', taxableValue: '10000',
    })

    const [row] = (await arAgeing(ctx)).filter((r) => r.invoiceId === inv.id)
    // 1,18,000 + 10,000 + 18% = 1,29,800
    expect(row.debited.toFixed(2)).toBe('11800.00')
    expect(row.gross.toFixed(2)).toBe('129800.00')
  })

  it('an advance cannot be adjusted beyond what the invoice still asks for', async () => {
    const inv = await invoice('2026-05-06')
    await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-06', reason: 'Deficiency in service', taxableValue: '20000',
    })
    const advance = await createAdvanceReceipt(ctx, {
      customerId, date: '2026-04-10', mode: 'NEFT', bankAccountId, amount: '118000',
    })

    await expect(adjustAdvance(ctx, {
      receiptId: advance.id, invoiceId: inv.id, date: '2026-06-20', amount: '118000',
    })).rejects.toThrow(/exceeds its outstanding/)
  })
})

describe('🔴 a receipt from one client, against another client’s invoice', () => {
  it('is refused, and names both', async () => {
    const other = await prisma.customer.create({ data: {
      companyId: ctx.companyId, name: 'Kerala Tourism Development Corporation', country: 'IN',
      stateCode: '32', customerType: 'B2B', paymentTermDays: 30, billingAddress: {},
    } })
    const inv = await invoice('2026-05-07')

    await expect(createReceipt(ctx, {
      customerId: other.id, date: '2026-06-25', mode: 'NEFT', bankAccountId,
      allocations: [{ invoiceId: inv.id, amount: '118000' }],
    })).rejects.toThrow(/not the client this receipt is from/)

    // nothing was posted: the invoice is untouched and neither ledger moved
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.amountReceived.toString()).toBe('0')
    expect((await clientLedger(ctx, other.id, PERIOD))!.lines).toHaveLength(0)
  })
})

describe('the reports that read the same figure', () => {
  it('client P&L outstanding matches the ageing, invoice for invoice', async () => {
    const rows = await clientPnl(ctx, PERIOD)
    const mine = rows.find((r) => r.customerId === customerId)!
    const fromAgeing = (await arAgeing(ctx))
      .filter((r) => r.customerId === customerId)
      .reduce((a, r) => a.plus(r.outstanding), new Decimal(0))
    expect(mine.outstanding.toFixed(2)).toBe(fromAgeing.toFixed(2))

    /**
     * 🔴 And both are ABOVE the client's own running account, by the advance this client has
     * paid and nothing has yet absorbed. That is not a disagreement: the ledger spans 1100 and
     * 2400 on purpose (docs/84), because a client holding an advance owes less than their
     * receivable says. What matters is that the gap is the advance and nothing else.
     */
    const ledger = await arPerLedger()
    const advances = await prisma.journalLine.aggregate({
      where: {
        customerId, account: { companyId: ctx.companyId, code: '2400' },
        journalEntry: { companyId: ctx.companyId, date: { lte: PERIOD.to } },
      },
      _sum: { debit: true, credit: true },
    })
    const heldOnAccount = new Decimal(advances._sum.credit?.toString() ?? '0')
      .minus(advances._sum.debit?.toString() ?? '0')
    expect(ledger.plus(heldOnAccount).toFixed(2)).toBe(fromAgeing.toFixed(2))
  })

  it('the month view totals the same outstanding as the ageing', async () => {
    const months = await invoicesByMonth(ctx, '2026-27')
    const fromMonths = months.reduce((a, m) => a.plus(m.outstanding), new Decimal(0))
    const fromAgeing = (await arAgeing(ctx)).reduce((a, r) => a.plus(r.collectible), new Decimal(0))
    expect(fromMonths.toFixed(2)).toBe(fromAgeing.toFixed(2))
  })
})
