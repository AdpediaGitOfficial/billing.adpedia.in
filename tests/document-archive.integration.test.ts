import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { createExpense, expensesWithoutEvidence } from '@/server/services/purchases/expense'
import { archivedDocument, archiveIssuedDocument, unarchivedInvoices } from '@/server/services/storage/document-archive'
import { uploadAttachment, readAttachment, detachAttachment } from '@/server/services/storage/attachment'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = '', invoiceId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  customerId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const raise = (date: string, rate = '100000') =>
  createInvoice(ctx, {
    customerId, date,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate, gstRatePct: '18' }],
  })

describe('🔴 the document as it was issued', () => {
  it('archives the invoice when it is sent', async () => {
    const draft = await raise('2026-05-10')
    // nothing is archived while it is a draft — a draft has not been issued
    expect(await archivedDocument(companyId, 'Invoice', draft.id)).toBeNull()

    const sent = await sendInvoice(ctx, draft.id)
    invoiceId = sent.id

    const archived = await archivedDocument(companyId, 'Invoice', sent.id)
    expect(archived).not.toBeNull()
    expect(archived!.kind).toBe('TAX_INVOICE')
    expect(archived!.contentType).toBe('application/pdf')
    expect(archived!.filename).toContain('.pdf')

    const { bytes } = await readAttachment(ctx, archived!.id)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('🔴 does not change when the company details change afterwards', async () => {
    const before = (await archivedDocument(companyId, 'Invoice', invoiceId))!
    const { bytes: original } = await readAttachment(ctx, before.id)

    // the kind of edit that silently rewrites every reprinted document
    await prisma.company.update({
      where: { id: companyId },
      data: { registeredAddress: { line1: 'Somewhere entirely different', city: 'Kochi', country: 'India' } },
    })

    const after = (await archivedDocument(companyId, 'Invoice', invoiceId))!
    const { bytes: now } = await readAttachment(ctx, after.id)
    expect(after.id).toBe(before.id)
    expect(now.equals(original)).toBe(true)
  })

  it('🔴 archives once, never twice', async () => {
    const result = await archiveIssuedDocument(ctx, {
      kind: 'TAX_INVOICE', entityType: 'Invoice', entityId: invoiceId,
      filename: 'again.pdf', pdf: Buffer.from('%PDF-1.4 different bytes'),
    })
    expect(result.archived).toBe(true)
    const all = await prisma.attachment.findMany({
      where: { companyId, entityType: 'Invoice', entityId: invoiceId, detachedAt: null },
    })
    expect(all).toHaveLength(1)
  })

  it('🔴 never fails the thing it is archiving', async () => {
    // a render that throws must not propagate — an invoice that cannot be issued because a
    // PDF renderer is unwell is a worse failure than one with no file on record
    const r = await archiveIssuedDocument(ctx, {
      kind: 'TAX_INVOICE', entityType: 'Invoice', entityId: 'no-such-invoice', filename: 'x.pdf',
      render: async () => { throw new Error('Chromium is not installed') },
    })
    expect(r.archived).toBe(false)
    expect(r.reason).toMatch(/Chromium is not installed/)
  })

  it('archives a credit note when it is raised', async () => {
    const note = await createCreditNote(ctx, {
      invoiceId, date: '2026-05-20', full: true, reason: 'Work descoped by the client',
    })
    const archived = await archivedDocument(companyId, 'CreditNote', note.id)
    expect(archived).not.toBeNull()
    expect(archived!.kind).toBe('CREDIT_NOTE')
  })

  it('names the invoices with no copy on file', async () => {
    const orphan = await sendInvoice(ctx, (await raise('2026-06-11', '50000')).id)
    // simulate one issued before any of this existed
    const a = (await archivedDocument(companyId, 'Invoice', orphan.id))!
    await detachAttachment(ctx, a.id, 'withdrawn for this test')

    const missing = await unarchivedInvoices(ctx)
    expect(missing.map((m) => m.id)).toContain(orphan.id)
    expect(missing.map((m) => m.id)).not.toContain(invoiceId)
  })

  it('🔴 a detached copy does not count as archived', async () => {
    const orphan = (await unarchivedInvoices(ctx))[0]
    expect(await archivedDocument(companyId, 'Invoice', orphan.id)).toBeNull()
  })
})

describe('🔴 the claim and its evidence in the same place', () => {
  let expenseId = ''

  it('lists an expense claiming input credit with nothing attached', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId } })
    const e = await createExpense(ctx, {
      date: '2026-06-02', description: 'Camera hire for the Nuvé shoot',
      categoryId: category.id, taxableValue: '50000', gstRatePct: '18', gstMode: 'INTRA', paidFrom: 'BANK',
    })
    expenseId = e.id

    const { rows, itcAtRisk } = await expensesWithoutEvidence(ctx)
    const row = rows.find((r) => r.id === e.id)
    expect(row).toBeTruthy()
    expect(row!.itc.toFixed(2)).toBe('9000.00')
    expect(itcAtRisk.gte('9000')).toBe(true)
  })

  it('drops out of the list once the bill is attached', async () => {
    await uploadAttachment(ctx, {
      kind: 'RECEIPT', entityType: 'Expense', entityId: expenseId,
      filename: 'camera-hire.pdf', contentType: 'application/pdf',
      bytes: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]),
    })
    const { rows } = await expensesWithoutEvidence(ctx)
    expect(rows.map((r) => r.id)).not.toContain(expenseId)
  })

  it('🔴 counts a detached bill as no bill', async () => {
    const [a] = await prisma.attachment.findMany({ where: { companyId, entityType: 'Expense', entityId: expenseId } })
    await detachAttachment(ctx, a.id, 'wrong file')
    const { rows } = await expensesWithoutEvidence(ctx)
    expect(rows.map((r) => r.id)).toContain(expenseId)
  })
})
