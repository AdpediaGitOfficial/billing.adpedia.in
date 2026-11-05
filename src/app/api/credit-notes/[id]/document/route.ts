import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { renderCreditNoteHtml } from '@/server/services/invoicing/render-credit-note'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { fileError } from '@/app/api/_lib/handler'
import { documentHtmlHeaders, pdfHeaders, wantsDownload } from '@/app/api/_lib/document'
import { archivedDocumentBytes } from '@/server/services/storage/document-archive'

/**
 * The credit note document — docs/48.
 *
 * Same contract as the invoice route: PDF by default because that is what gets emailed,
 * `?format=html` for the render tests and for debugging a layout in a browser.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    // 🔴 docs/57 — same hole as the invoice document route
    assertCan(ctx.role, 'invoices', 'read')
    const { id } = await params
    const url = new URL(req.url)
    const format = url.searchParams.get('format')
    const download = wantsDownload(url)

    const note = await prisma.creditNote.findFirst({
      where: { id, companyId: ctx.companyId }, select: { number: true },
    })
    const name = pdfFilename(note?.number ?? 'credit-note')

    // 🔴 docs/59 — the copy archived when the note was raised is the one that was issued
    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const bytes = await archivedDocumentBytes(ctx, 'CreditNote', id)
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: pdfHeaders(name, { download, source: 'archived-at-issue' }),
        })
      }
    }

    const html = await renderCreditNoteHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: documentHtmlHeaders(),
      })
    }

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: pdfHeaders(name, { download, source: 'rebuilt-now' }),
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'credit-notes/[id]/document', 'Could not render the credit note')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
