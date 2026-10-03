import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { renderCreditNoteHtml } from '@/server/services/invoicing/render-credit-note'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { AppError } from '@/server/errors'
import { archivedDocument } from '@/server/services/storage/document-archive'
import { readAttachment } from '@/server/services/storage/attachment'

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

    const note = await prisma.creditNote.findFirst({
      where: { id, companyId: ctx.companyId }, select: { number: true },
    })
    const name = pdfFilename(note?.number ?? 'credit-note')

    // 🔴 docs/59 — the copy archived when the note was raised is the one that was issued
    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const archived = await archivedDocument(ctx.companyId, 'CreditNote', id)
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

    const html = await renderCreditNoteHtml(ctx.companyId, id)

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
        'content-disposition': `inline; filename="${name}"`,
        'x-document-source': 'rebuilt-now',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not render the credit note', { status })
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
