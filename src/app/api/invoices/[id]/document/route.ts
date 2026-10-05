import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { fileError } from '@/app/api/_lib/handler'
import { archivedDocument } from '@/server/services/storage/document-archive'
import { readAttachment } from '@/server/services/storage/attachment'

/**
 * The invoice document.
 *
 * PDF by default, because that is what gets emailed, filed and sent over WhatsApp.
 * `?format=html` returns the same document as HTML — it is what the render tests assert
 * against, and it is far easier to debug a layout problem in a browser than in a PDF.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    // 🔴 docs/57 — renderInvoiceHtml takes a companyId, not a context, so nothing below
    // this line asks who is reading. An EMPLOYEE holds no `invoices` capability and could
    // download every invoice this company has ever issued by walking the ids.
    assertCan(ctx.role, 'invoices', 'read')
    const { id } = await params
    const url = new URL(req.url)
    const format = url.searchParams.get('format')

    const invoice = await prisma.invoice.findFirst({
      where: { id, companyId: ctx.companyId }, select: { number: true, status: true },
    })
    const name = pdfFilename(invoice?.status === 'DRAFT' ? 'DRAFT' : invoice?.number ?? 'invoice')

    /**
     * 🔴 docs/59 — the ARCHIVED copy wins, and nothing re-renders over it.
     *
     * The bytes stored when the invoice was sent are the document the client received. This
     * route re-rendering from today's data and today's template would produce a different
     * file for the same invoice number, and the two would be indistinguishable.
     *
     * `?rebuild=1` re-renders deliberately, for comparing the two. `?format=html` always
     * re-renders, because the archive is a PDF — and both say so in a header.
     */
    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const archived = await archivedDocument(ctx.companyId, 'Invoice', id)
      if (archived) {
        const { bytes } = await readAttachment(ctx, archived.id)
        return new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `inline; filename="${name}"`,
            'x-document-source': 'archived-at-issue',
            'cache-control': 'private, no-store',
          },
        })
      }
    }

    const html = await renderInvoiceHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-document-source': 'rebuilt-now',
          'cache-control': 'private, no-store',
        },
      })
    }

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        // inline, so tapping it on a phone opens a preview rather than dumping a file in
        // Downloads that the person then has to go and find
        'content-disposition': `inline; filename="${name}"`,
        // 🔴 this is a RECONSTRUCTION, not the document that was issued
        'x-document-source': 'rebuilt-now',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'invoices/[id]/document', 'Could not render the invoice')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
