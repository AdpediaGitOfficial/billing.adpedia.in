import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal, ZERO } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { createAdvanceReceipt } from '@/server/services/sales/advance'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill, payBill } from '@/server/services/purchases/bill'
import { clientLedger, vendorLedger, partyReconciliation, partyBalances } from '@/server/services/reports/party-ledger'
import { accountLedger } from '@/server/services/reports/ledger'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let customerId = '', subbieId = '', bankId = ''
const PERIOD = { from: new Date('2026-04-01T00:00:00Z'), to: new Date('2027-03-31T23:59:59Z') }

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  customerId = (await prisma.customer.create({
    data: { companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN',
      stateCode: '32', gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15,
      billingAddress: {}, defaultTdsSection: '194J' },
  })).id

  // 🔴 a sub-contractor IS a vendor — `vendorType: 'SUBCONTRACTOR'`. One ledger shape covers
  // suppliers, freelancers and sub-contractors; the type is a label on the same account.
  subbieId = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })).id

  // 🔴 docs/80 — the account that actually appears on an invoice, not "whichever one
  // Postgres finds convenient". `where: { companyId }` alone cannot pick a row out of a set.
  bankId = (await prisma.companyBankAccount.findFirstOrThrow({
    where: { companyId: company.id, showOnInvoice: true },
  })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

/**
 * A running account with one client — docs/84, docs/81 §6.
 */
describe('🔴 the client ledger', () => {
  it('runs invoice, receipt and the TDS inside it', async () => {
    const inv = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId, date: '2026-05-10', tdsSection: '194J',
      lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
    })).id)
    expect(inv.grandTotal.toString()).toBe('118000')
    expect(inv.tdsAmount.toString()).toBe('10000')

    let led = (await clientLedger(ctx, customerId, PERIOD))!
    expect(led.closing.toString()).toBe('118000')
    expect(led.lines).toHaveLength(1)
    expect(led.lines[0].accountCode).toBe('1100')

    // settled: ₹1,08,000 of cash and ₹10,000 the client withheld
    await createReceipt(ctx, {
      customerId, date: '2026-06-01', mode: 'NEFT', reference: 'NEFT/1',
      allocations: [{ invoiceId: inv.id, amount: '108000', tdsAmount: '10000' }],
    })

    led = (await clientLedger(ctx, customerId, PERIOD))!
    expect(led.closing.toString()).toBe('0')
    expect(led.lines).toHaveLength(2)
  })

  /**
   * 🔴 `postReceipt` credits AR ONCE, for cash plus the TDS withheld, so the row reads
   * ₹1,18,000 and nothing on it says ₹10,000 was never cash. The other side of the entry is
   * what says it — and it must be presentational only: adding the 1310 debit into the ledger
   * would credit the client twice for one deduction.
   */
  it('🔴 shows how the settlement split, without counting it twice', async () => {
    const led = (await clientLedger(ctx, customerId, PERIOD))!
    const receipt = led.lines.find((l) => l.sourceType === 'RECEIPT')!

    expect(receipt.credit.toString()).toBe('118000')
    const contra = Object.fromEntries(receipt.contra.map((c) => [c.code, c.amount.toString()]))
    expect(contra['1010']).toBe('108000')   // the bank
    expect(contra['1310']).toBe('10000')    // TDS receivable u/s 194J

    // 🔴 and the ledger's own movement is the AR line alone
    expect(led.debit.minus(led.credit).toString()).toBe('0')
  })

  /**
   * 🔴 docs/81 §6 — "a client who has paid an advance owes less than their AR says." The
   * ledger spans 1100 AND 2400, so the advance reduces the balance instead of sitting in a
   * liability account nobody looks at.
   */
  it('🔴 nets an advance held against what they owe', async () => {
    await createAdvanceReceipt(ctx, {
      customerId, date: '2026-07-01', mode: 'NEFT', amount: '59000',
      gstRatePct: '18', reference: 'NEFT/2', bankAccountId: bankId,
    })

    const led = (await clientLedger(ctx, customerId, PERIOD))!
    const advance = led.lines.find((l) => l.accountCode === '2400')!
    expect(advance.credit.toString()).toBe('50000')
    // 🔴 the taxable value, not the cash. The GST declared on an advance is credited to the
    // output tax account, not to 2400 — the page says so rather than leaving it to be
    // reconciled by hand.
    expect(advance.contra.some((c) => c.code === '2110')).toBe(true)
    expect(led.closing.toString()).toBe('-50000')
    expect(led.accounts.map((a) => a.code)).toEqual(['1100', '2400'])
  })

  /**
   * 🔴 docs/91 — a USD invoice posts rupees at its rate, and the statement warns only about a
   * document that was booked with none.
   *
   * It used to post USD 6,500 into 1100 as 6,500, so every foreign client's statement was
   * flagged as mixed. A rate fixes the posting; what is left to flag is a document sent before
   * rates were captured, which is still in the account at face value.
   */
  it('🔴 carries a USD client in rupees, and warns only about a document booked with no rate', async () => {
    const dubai = await prisma.customer.create({
      data: { companyId: ctx.companyId, name: 'Nuvé Holdings FZ-LLC', country: 'AE', stateCode: null,
        customerType: 'EXPORT', currency: 'USD', paymentTermDays: 30, billingAddress: {} },
    })
    const lut = await prisma.companyLut.create({
      data: { companyId: ctx.companyId, arn: 'AD320326LEDG01', fyLabel: '2026-27',
        validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31') },
    })
    const usd = await sendInvoice(ctx, (await createInvoice(ctx, {
      customerId: dubai.id, date: '2026-08-20', fxRate: '84',
      lines: [{ description: 'Brand film', sacCode: '998387', quantity: '1', rate: '6500', gstRatePct: '0' }],
    })).id)
    expect(usd.currency).toBe('USD')

    const led = (await clientLedger(ctx, dubai.id, PERIOD))!
    // USD 6,500 at ₹84 is in the account as rupees, and nothing about it is mixed
    expect(led.closing.toString()).toBe('546000')
    expect(led.foreignCurrency).toEqual([])

    // a document with no rate is the one case left to name
    await prisma.invoice.update({ where: { id: usd.id }, data: { fxRate: 1 } })
    expect((await clientLedger(ctx, dubai.id, PERIOD))!.foreignCurrency).toEqual([{ currency: 'USD', count: 1 }])

    // and a rupee-only client is not warned about something that is not true of them
    expect((await clientLedger(ctx, customerId, PERIOD))!.foreignCurrency).toEqual([])

    await prisma.companyLut.delete({ where: { id: lut.id } })
  })

  it('refuses an id from another company rather than returning an empty statement', async () => {
    const other = await prisma.company.create({
      data: { legalName: 'Somebody Else Pvt Ltd', pan: 'AAACS1111A', gstin: '32AAACS1111A1Z5',
        constitution: 'PRIVATE_LIMITED', stateCode: '32', registeredAddress: {} },
    })
    const theirs = await prisma.customer.create({
      data: { companyId: other.id, name: 'Their Client', country: 'IN', stateCode: '32',
        customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
    })
    expect(await clientLedger(ctx, theirs.id, PERIOD)).toBeNull()
    await prisma.customer.delete({ where: { id: theirs.id } })
    await prisma.company.delete({ where: { id: other.id } })
  })
})

describe('🔴 the vendor ledger, which is also the sub-contractor ledger', () => {
  it('runs bill, TDS withheld and payment, and closes at what is actually payable', async () => {
    await approveBill(ctx, (await createBill(ctx, {
      vendorId: subbieId, billNumber: 'EX/300', billDate: '2026-06-10', tdsSection: '194C',
      lines: [{ description: 'Edit suite', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })).id)

    let led = (await vendorLedger(ctx, subbieId, PERIOD))!
    expect(led.party.kind).toBe('VENDOR')
    expect(led.accounts.map((a) => a.code)).toEqual(['2000'])

    /**
     * 🔴 ₹1,18,000 billed, ₹2,000 withheld under 194C on the taxable value — so ₹1,16,000 is
     * payable, and that is the figure a payment will match. `postTdsDeduction` is its own
     * entry, which is why the deduction is a row here rather than netted into the bill.
     */
    expect(led.credit.toString()).toBe('118000')
    expect(led.debit.toString()).toBe('2000')
    expect(led.closing.toString()).toBe('116000')
    const tds = led.lines.find((l) => (l.lineNarration ?? '').includes('TDS'))!
    expect(tds.debit.toString()).toBe('2000')
    expect(tds.contra.some((c) => c.code === '2230')).toBe(true)   // TDS payable 194C

    const bill = await prisma.vendorBill.findFirstOrThrow({ where: { billNumber: 'EX/300' } })
    await payBill(ctx, { billId: bill.id, date: '2026-07-05', amount: '116000', mode: 'NEFT', reference: 'NEFT/9' })

    led = (await vendorLedger(ctx, subbieId, PERIOD))!
    expect(led.closing.toString()).toBe('0')
  })

  it('signs the balance as what WE owe, the opposite way up from a client', async () => {
    // a vendor's bill is a credit and raises the balance; a client's invoice is a debit and
    // raises theirs. One component renders both, so the sign has to come from the service.
    const led = (await vendorLedger(ctx, subbieId, PERIOD))!
    const billed = led.lines.find((l) => l.credit.gt(0))!
    expect(billed.movement.toString()).toBe('118000')
    const paid = led.lines.find((l) => (l.lineNarration ?? '').includes('Payment'))!
    expect(paid.movement.toString()).toBe('-116000')
  })
})

/**
 * 🔴 docs/81 §6 — the reconciliation IS the guard.
 *
 * A posting added later that forgets `customerId` drops money out of every client ledger
 * while the trial balance still balances perfectly. Nothing fails, nothing warns, and the
 * first symptom is a statement sent to a client that is quietly short. It is zero today and
 * the only thing that keeps it zero is something that looks.
 */
describe('🔴 every rupee on a control account belongs to somebody', () => {
  for (const [kind, codes] of [['CUSTOMER', ['1100', '2400']], ['VENDOR', ['2000']]] as const) {
    it(`${kind.toLowerCase()} ledgers add up to the control account, with nothing left over`, async () => {
      const rec = await partyReconciliation(ctx, kind, PERIOD)

      expect(rec.unattributed.count, `${rec.unattributed.count} line(s) on ${codes.join('/')} carry no ${kind.toLowerCase()}`).toBe(0)
      expect(rec.difference.toString()).toBe('0')
      expect(rec.control.toString()).toBe(rec.parties.toString())
      expect(rec.accounts.map((a) => a.code)).toEqual([...codes])
    })
  }

  it('and the control figure is the same one the account ledger reports', async () => {
    // 🔴 the cross-check that makes the one above mean something: if both sides were computed
    // the same wrong way, they would agree with each other and with nothing else.
    const rec = await partyReconciliation(ctx, 'VENDOR', PERIOD)
    const ap = (await accountLedger(ctx, '2000', PERIOD))!
    expect(rec.control.toString()).toBe(ap.account.closing.toString())
  })

  it('partyBalances agrees with the ledger it summarises, party by party', async () => {
    for (const [kind, ids] of [['CUSTOMER', [customerId]], ['VENDOR', [subbieId]]] as const) {
      const balances = await partyBalances(ctx, kind, PERIOD.to)
      for (const id of ids) {
        const led = kind === 'CUSTOMER'
          ? (await clientLedger(ctx, id, PERIOD))!
          : (await vendorLedger(ctx, id, PERIOD))!
        expect((balances.get(id) ?? ZERO).toString(), `${kind} ${id}`).toBe(led.closing.toString())
      }
    }
  })

  /**
   * 🔴 Neutering check, in the suite rather than by hand: a line written onto AR with no
   * customer must make the reconciliation say so. Without this, "unattributed is 0" could
   * mean the query is wrong rather than the books are clean.
   */
  it('is not vacuous — a line with no party is reported', async () => {
    const ar = await prisma.account.findUniqueOrThrow({
      where: { companyId_code: { companyId: ctx.companyId, code: '1100' } },
    })
    // 🔴 docs/95 — this used to bolt an unbalanced line onto an existing entry and delete it
    // afterwards. The database now refuses both (a posted line cannot be added to, changed or
    // removed), so the orphan is a SEPARATE, balanced entry: ₹1 onto AR with no customer, against
    // an account the party ledgers do not read. Entries cannot be deleted either, so it is
    // reversed rather than removed — see `finally`.
    const other = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.companyId, code: '4020' },
    })
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: ctx.companyId, label: '2026-27' } })
    const last = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.companyId, financialYearId: fy.id }, orderBy: { entryNo: 'desc' },
    })
    const orphan = await prisma.journalEntry.create({
      data: {
        companyId: ctx.companyId, financialYearId: fy.id, entryNo: last.entryNo + 1, date: PERIOD.to,
        narration: 'neutering fixture', sourceType: 'MANUAL', postedById: ctx.userId,
        lines: { create: [
          { accountId: ar.id, debit: new Decimal('1').toFixed(2), credit: '0' },
          { accountId: other.id, debit: '0', credit: new Decimal('1').toFixed(2) },
        ] },
      },
    })
    try {
      const rec = await partyReconciliation(ctx, 'CUSTOMER', PERIOD)
      expect(rec.unattributed.count).toBe(1)
      expect(rec.unattributed.debit.toString()).toBe('1')
      expect(rec.difference.toString()).toBe('1')
    } finally {
      // the last test in the file, and the next file truncates every table: nothing to undo
      void orphan
    }
  })
})
