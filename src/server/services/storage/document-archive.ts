import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import type { AttachmentKind } from '@prisma/client'
import { readAttachment, uploadAttachment } from './attachment'
import { htmlToPdf } from '@/server/services/invoicing/pdf'

/**
 * Keeping the document that was issued — docs/59.
 *
 * 🔴 Every document in this system is RE-RENDERED on request, from today's data and today's
 * template. docs/41 froze the bill-to details on the invoice so a customer's new address
 * could not rewrite an old document, and that was only half of it: the company's own address,
 * the logo, the signature and the template itself are all read live. docs/33 fixed three
 * defects in the invoice layout; docs/48 changed its bindings. An invoice sent in May and
 * reprinted in October is not the document the client is holding.
 *
 * For a tax invoice that is not a cosmetic difference. The question at an assessment is
 * **what did you issue**, and until now nothing here could answer it — only what the same
 * data would look like today.
 *
 * So the bytes are archived at the moment of issue, and the moment of issue is different for
 * each document: an invoice is issued when it is sent, a credit note when it is raised, a
 * payslip when it is handed over.
 */

export interface ArchiveResult {
  archived: boolean
  attachmentId?: string
  /** why not, in words a person can act on */
  reason?: string
}

/**
 * 🔴 This never throws, and that is the whole design.
 *
 * Archiving renders a PDF, which means launching a browser. If Chromium is missing, out of
 * memory, or simply slow, that must not stop an invoice being issued — a company that cannot
 * bill because a PDF renderer is unwell is a worse failure than one without a file on record.
 * So the archive is best-effort, and what is NOT archived is reported rather than hidden.
 */
export async function archiveIssuedDocument(
  ctx: RequestContext,
  args: {
    kind: AttachmentKind
    entityType: string
    entityId: string
    filename: string
    /** the HTML to render, or the PDF bytes if the caller already has them */
    render?: () => Promise<string>
    pdf?: Buffer
  },
): Promise<ArchiveResult> {
  try {
    // 🔴 archived ONCE. A document is issued once; re-archiving on a later send would
    // store a second, different PDF beside the first and nothing would say which was sent.
    const existing = await archivedDocument(ctx.companyId, args.entityType, args.entityId)
    if (existing) return { archived: true, attachmentId: existing.id }

    /**
     * 🔴 The caller may hand over bytes it has ALREADY produced, and the payslip route does.
     *
     * Rendering again here would mean the file archived and the file served are two separate
     * renders of the same document — and the whole point of an archive is that the bytes on
     * record are the bytes that went out. Two renders are also two browser round-trips for
     * one request.
     */
    const pdf = args.pdf ?? await htmlToPdf(await args.render!())
    const row = await uploadAttachment(ctx, {
      kind: args.kind,
      entityType: args.entityType,
      entityId: args.entityId,
      filename: args.filename,
      contentType: 'application/pdf',
      bytes: pdf,
    })
    return { archived: true, attachmentId: row.id }
  } catch (e) {
    /**
     * 🔴 docs/83 §5 — and the reason is WRITTEN DOWN, not just returned.
     *
     * Three of the four callers — `sendInvoice`, `issueCreditNote`, `issueDebitNote` — call
     * this with `await` and discard the result, which is correct for the send (a render must
     * not fail an issue) and was the whole of the reporting. So a failed archive produced:
     * an invoice issued with no copy on file, a `reason` string built and thrown away, and
     * **nothing in any log**. The screen says a copy is missing (docs/59) and could not say
     * why; the next click, "View document", hit the same failure and showed the same generic
     * sentence. Diagnosing it meant guessing.
     *
     * docs/80's rule, reached from the other side: the message a person sees stays plain, and
     * the cause goes somewhere it can be read. This is the only place that still knows it.
     */
    console.error(
      `archive · ${args.entityType} ${args.entityId} (${args.kind}) has no copy on file —`,
      e,
    )
    return { archived: false, reason: e instanceof Error ? e.message : 'The document could not be rendered' }
  }
}

/** The archived copy, if there is one. Detached copies do not count — they were withdrawn. */
export async function archivedDocument(companyId: string, entityType: string, entityId: string) {
  return prisma.attachment.findFirst({
    where: {
      companyId, entityType, entityId, detachedAt: null,
      // 🔴 the issued-document kinds only. A file somebody uploaded against the same record
      // is evidence of something else and must not be served as "the document as issued".
      kind: { in: ['TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'VOUCHER', 'PAYSLIP'] },
    },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * The archived bytes — or nothing, so the caller renders instead. docs/85 §1.
 *
 * 🔴 The archive is BEST EFFORT on the way in and was FATAL on the way out.
 *
 * `archiveIssuedDocument` above never throws, on the explicit reasoning that a company must
 * be able to bill even when the PDF renderer is unwell. Serving took the opposite line
 * without anyone deciding it: all four document routes read the attachment directly, so a row
 * pointing at bytes that cannot be read — a storage directory not carried across in a move, a
 * `STORAGE_DIR` pointing somewhere new, a file restored without its blobs, a permission — came
 * out as a flat 500 on a document the app could have rebuilt from the database in a second.
 *
 * The missing copy is still a real loss and still reported: what went out is no longer on
 * record (docs/59), and `x-document-source` says plainly that this is a reconstruction. But
 * the person asking for their invoice gets their invoice.
 */
export async function archivedDocumentBytes(
  ctx: RequestContext, entityType: string, entityId: string,
): Promise<Buffer | null> {
  const archived = await archivedDocument(ctx.companyId, entityType, entityId)
  if (!archived) return null
  try {
    const { bytes } = await readAttachment(ctx, archived.id)
    return bytes
  } catch (e) {
    // 🔴 the storage KEY is in the log line. Without it this says a file is missing and not
    // which file, and the whole point is to be able to go and look.
    console.error(
      `archive · ${entityType} ${entityId} has a copy on record (attachment ${archived.id}, `
      + `key ${archived.storageKey}) whose bytes could not be read — serving a fresh render instead.`,
      e,
    )
    return null
  }
}

/**
 * Which issued documents have no copy on file.
 *
 * 🔴 Reported, not silently tolerated. An invoice issued before this existed, or one whose
 * render failed, has no archived copy — and a list of invoices where some have one and some
 * do not is useless unless the gaps are named.
 */
export async function unarchivedInvoices(ctx: RequestContext) {
  const sent = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, status: { in: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] } },
    select: { id: true, number: true, date: true, sentAt: true },
    orderBy: { date: 'desc' },
  })
  if (sent.length === 0) return []

  const archived = await prisma.attachment.findMany({
    where: {
      companyId: ctx.companyId, entityType: 'Invoice',
      // docs/82 §5 — an unregistered entity's invoices are bills of supply, and a report of
      // "sent with no copy on file" that only knew about tax invoices would call every one of
      // them missing
      kind: { in: ['TAX_INVOICE', 'BILL_OF_SUPPLY'] }, detachedAt: null,
      entityId: { in: sent.map((i) => i.id) },
    },
    select: { entityId: true },
  })
  const have = new Set(archived.map((a) => a.entityId))
  return sent.filter((i) => !have.has(i.id))
}
