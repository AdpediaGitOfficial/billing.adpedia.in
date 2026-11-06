import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { addBankAccount } from '@/server/services/company/bank-account'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createReceipt } from '@/server/services/sales/receipt'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import type { RequestContext } from '@/server/context'

/**
 * 🔴 docs/88 — nothing in the application could create a bank account. The seed did, for the
 * first company; the second entity had none, so its invoices printed "—" under Payment details
 * and recording a receipt threw a database "not found".
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext, customerId = '', invoiceId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }
  const b = await createCompany(ctxA, {
    legalName: 'A PERSONAL ACCOUNT', constitution: 'PROPRIETORSHIP',
    pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'PER',
    address: { line1: 'Thommana', city: 'Thrissur', pincode: '680683' },
  })
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: b.id, name: 'A freelance client', country: 'IN', stateCode: '32',
    customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
  } })).id
  const draft = await createInvoice(ctxB, {
    customerId, date: '2026-10-01',
    lines: [{ description: 'Freelance work', quantity: '1', rate: '10000', gstRatePct: '0' }],
  })
  invoiceId = (await sendInvoice(ctxB, draft.id)).id
})
afterAll(async () => { await prisma.$disconnect() })

const hdfc = {
  label: 'HDFC — Savings', bankName: 'HDFC Bank Ltd', accountNo: '50100123456789',
  ifsc: 'HDFC0000123', swift: 'HDFCINBB',
}

describe('an entity with no bank account', () => {
  it('🔴 says so in a sentence, rather than throwing a database error', async () => {
    await expect(createReceipt(ctxB, {
      customerId, date: '2026-10-10', mode: 'NEFT',
      allocations: [{ invoiceId, amount: '10000' }],
    })).rejects.toThrow(/no bank account yet/i)
  })

  it('prints nothing under Payment details — there is nothing to print', async () => {
    const html = await renderInvoiceHtml(ctxB.companyId, invoiceId)
    expect(html).not.toContain('50100123456789')
  })
})

describe('adding the first bank account', () => {
  it('becomes the default and prints on the invoice, mapped to the ledger account the chart made', async () => {
    const acct = await addBankAccount(ctxB, hdfc)
    expect(acct.isDefault).toBe(true)
    expect(acct.showOnInvoice).toBe(true)
    expect(acct.accountName).toBe('A PERSONAL ACCOUNT')   // defaults to the entity

    const gl = await prisma.account.findUniqueOrThrow({ where: { id: acct.ledgerAccountId! } })
    expect(gl.code).toBe('1010')
    expect(gl.name).toBe('HDFC — Savings')

    const html = await renderInvoiceHtml(ctxB.companyId, invoiceId)
    expect(html).toContain('50100123456789')
    expect(html).toContain('HDFC0000123')
    expect(html).toContain('HDFCINBB')
  })

  it('🔴 lets the entity record the money when it arrives', async () => {
    const r = await createReceipt(ctxB, {
      customerId, date: '2026-10-10', mode: 'NEFT',
      allocations: [{ invoiceId, amount: '10000' }],
    })
    expect(r.amount.toString()).toBe('10000')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe('PAID')

    // and it landed in THIS entity's bank ledger account
    const bank = await prisma.journalLine.aggregate({
      where: { account: { companyId: ctxB.companyId, code: '1010' }, journalEntry: { companyId: ctxB.companyId } },
      _sum: { debit: true },
    })
    expect(bank._sum.debit?.toString()).toBe('10000')
  })
})

describe('adding a second bank account', () => {
  it('gets its own ledger account, so a statement reconciles against one balance', async () => {
    const acct = await addBankAccount(ctxB, {
      label: 'Wise — USD', bankName: 'Wise', accountNo: '8310012345', swift: 'TRWIUS35XXX',
    })
    const gl = await prisma.account.findUniqueOrThrow({ where: { id: acct.ledgerAccountId! } })
    expect(gl.code).toBe('1011')
    expect(gl.subType).toBe('BANK')
  })

  it('does not take over the invoice or the default unless asked', async () => {
    const rows = await prisma.companyBankAccount.findMany({ where: { companyId: ctxB.companyId }, orderBy: { label: 'asc' } })
    expect(rows.filter((r) => r.isDefault).map((r) => r.label)).toEqual(['HDFC — Savings'])
    expect(rows.filter((r) => r.showOnInvoice).map((r) => r.label)).toEqual(['HDFC — Savings'])
  })

  it('moves both together when asked — there is only ever ONE of each', async () => {
    await addBankAccount(ctxB, {
      label: 'ICICI — Current', bankName: 'ICICI Bank', accountNo: '000405012345', ifsc: 'ICIC0000004',
      showOnInvoice: true, makeDefault: true,
    })
    const rows = await prisma.companyBankAccount.findMany({ where: { companyId: ctxB.companyId } })
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1)
    expect(rows.filter((r) => r.showOnInvoice)).toHaveLength(1)
    expect(rows.find((r) => r.isDefault)!.label).toBe('ICICI — Current')
  })
})

describe('what is refused', () => {
  it('a duplicate account number', async () => {
    await expect(addBankAccount(ctxB, { ...hdfc, label: 'Again' })).rejects.toThrow(/already on file/)
  })

  it('an IFSC that is not one', async () => {
    await expect(addBankAccount(ctxB, { ...hdfc, label: 'Bad IFSC', accountNo: '1234567890', ifsc: 'HDFC123' }))
      .rejects.toThrow(/not an IFSC/)
  })

  it('a SWIFT that is not one', async () => {
    await expect(addBankAccount(ctxB, { ...hdfc, label: 'Bad SWIFT', accountNo: '1234567891', ifsc: '', swift: 'ABC' }))
      .rejects.toThrow(/not a SWIFT/)
  })

  it('🔴 an auditor — the check is in the service, not on the screen', async () => {
    await expect(addBankAccount({ ...ctxB, role: 'AUDITOR' }, { ...hdfc, label: 'Y', accountNo: '1234567892' }))
      .rejects.toThrow()
  })

  it('an overseas account with no IFSC is fine', async () => {
    const a = await addBankAccount(ctxB, { label: 'Revolut — EUR', bankName: 'Revolut', accountNo: 'LT601010012345678901', swift: 'REVOLT21' })
    expect(a.ifsc).toBeNull()
  })

  it('and it cannot be added to the OTHER entity by id — the company comes from the session', async () => {
    const before = await prisma.companyBankAccount.count({ where: { companyId: ctxA.companyId } })
    await addBankAccount(ctxB, { label: 'Zeta — Savings', bankName: 'Zeta Bank', accountNo: '9999999999' })
    expect(await prisma.companyBankAccount.count({ where: { companyId: ctxA.companyId } })).toBe(before)
  })
})
