import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { renderCreditNoteHtml } from '@/server/services/invoicing/render-credit-note'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { AppError } from '@/server/errors'

/**
 * The credit note document — docs/48.
 *
 * Same contract as the invoice route: PDF by default because that is what gets emailed,
 * `?format=html` for the render tests and for debugging a layout in a browser.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    const { id } = await params
    const format = new URL(req.url).searchParams.get('format')

    const html = await renderCreditNoteHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    const note = await prisma.creditNote.findFirst({
      where: { id, companyId: ctx.companyId }, select: { number: true },
    })

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${pdfFilename(note?.number ?? 'credit-note')}"`,
        'cache-control': 'no-store',
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
