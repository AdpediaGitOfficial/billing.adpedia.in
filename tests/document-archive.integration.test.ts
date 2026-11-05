import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { createExpense, expensesWithoutEvidence } from '@/server/services/purchases/expense'
import { archivedDocument, archivedDocumentBytes, archiveIssuedDocument, unarchivedInvoices } from '@/server/services/storage/document-archive'
import { uploadAttachment, readAttachment, detachAttachment } from '@/server/services/storage/attachment'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { storage } from '@/server/services/storage/driver'
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

  /**
   * 🔴 docs/83 §5 — and it says so somewhere a person can read.
   *
   * The `reason` above was built and handed back, and the three callers that matter —
   * `sendInvoice`, `issueCreditNote`, `issueDebitNote` — all `await` this and discard the
   * result. That is right for the send: a render must never fail an issue. It also meant a
   * failed archive produced an invoice with no copy on file, a reason string thrown away,
   * and NOTHING in any log. The screen could say a copy was missing and never why, and the
   * next click — "View document" — hit the same failure behind the same generic sentence.
   */
  it('🔴 and writes down why, because the caller is entitled to ignore it', async () => {
    const said: unknown[][] = []
    const real = console.error
    console.error = (...a: unknown[]) => { said.push(a) }
    try {
      await archiveIssuedDocument(ctx, {
        kind: 'TAX_INVOICE', entityType: 'Invoice', entityId: 'inv-with-no-renderer', filename: 'x.pdf',
        render: async () => { throw new Error('Chromium is not installed') },
      })
    } finally {
      console.error = real
    }

    const line = said.map((a) => a.map(String).join(' ')).join('\n')
    expect(line, 'a failed archive logged nothing at all').toMatch(/archive/)
    expect(line).toMatch(/inv-with-no-renderer/)       // WHICH document has no copy
    expect(line).toMatch(/Chromium is not installed/)  // and WHY
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

/**
 * 🔴 docs/85 §1 — the archive was best effort going in and fatal coming out.
 *
 * `archiveIssuedDocument` above never throws, on the stated reasoning that a company must be
 * able to bill even when the renderer is unwell. Serving took the opposite line without anyone
 * choosing it: all four document routes read the attachment directly, so an Attachment row
 * pointing at bytes that are not there — a storage directory left behind in a move, a
 * STORAGE_DIR repointed, a restore of the database without the blobs — came out of
 * `/api/invoices/[id]/document` as a flat 500 on a document the database could rebuild in a
 * second.
 */
describe('🔴 an archived copy that cannot be read', () => {
  let orphanedId = '', attachmentId = '', storageKey = ''

  beforeAll(async () => {
    const sent = await sendInvoice(ctx, (await raise('2026-07-03', '75000')).id)
    orphanedId = sent.id
    const a = (await archivedDocument(companyId, 'Invoice', sent.id))!
    attachmentId = a.id
    storageKey = a.storageKey
    // what a move that left the storage directory behind looks like from in here
    await storage().remove(storageKey)
  })

  it('still has the row — the loss is invisible to the database', async () => {
    const a = await archivedDocument(companyId, 'Invoice', orphanedId)
    expect(a).not.toBeNull()
    expect(a!.id).toBe(attachmentId)
    await expect(readAttachment(ctx, attachmentId)).rejects.toThrow()
  })

  it('🔴 reports no bytes rather than throwing, so the caller can render', async () => {
    const said: unknown[][] = []
    const real = console.error
    console.error = (...a: unknown[]) => { said.push(a) }
    let bytes: Buffer | null = null
    try {
      bytes = await archivedDocumentBytes(ctx, 'Invoice', orphanedId)
    } finally {
      console.error = real
    }

    expect(bytes).toBeNull()

    const line = said.map((a) => a.map(String).join(' ')).join('\n')
    expect(line, 'an unreadable archive logged nothing').toMatch(/archive/)
    expect(line).toMatch(new RegExp(orphanedId))
    // 🔴 the storage KEY, or this says a file is missing and not which file
    expect(line).toMatch(new RegExp(storageKey.replace(/[/.]/g, '\\$&')))
  })

  it('🔴 and the document is still obtainable, which is the whole point', async () => {
    const bytes = await archivedDocumentBytes(ctx, 'Invoice', orphanedId)
      ?? await htmlToPdf(await renderInvoiceHtml(companyId, orphanedId))
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('an archive that IS readable is still preferred over a render', async () => {
    const bytes = await archivedDocumentBytes(ctx, 'Invoice', invoiceId)
    expect(bytes).not.toBeNull()
    const { bytes: direct } = await readAttachment(ctx, (await archivedDocument(companyId, 'Invoice', invoiceId))!.id)
    expect(bytes!.equals(direct)).toBe(true)
  })
})

describe('🔴 the claim and its evidence in the same place', () => {
  let expenseId = ''

  it('lists an expense claiming input credit with nothing attached', async () => {
/**
     * 🔴 A NAMED category, not whichever one comes back first — docs/80.
     *
     * This read `findFirstOrThrow({ where: { companyId } })` with no order, and nine categories
     * are seeded. Postgres returns whichever suits the heap, and `TRAVEL` has `itcDefault:
     * PARTIAL` — which makes `createExpense` demand a blocking reason and throw. The suite was
     * green by luck for as long as the physical order happened to favour a `FULL` category, and
     * it stopped the moment enough rows were written to move it. docs/78's lesson, in a test.
     */
    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, code: 'OFFICE' } })
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
