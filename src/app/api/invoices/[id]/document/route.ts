import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { renderInvoiceHtml } from '@/server/services/invoicing/render'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { AppError } from '@/server/errors'

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
    const { id } = await params
    const format = new URL(req.url).searchParams.get('format')

    const html = await renderInvoiceHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id, companyId: ctx.companyId }, select: { number: true, status: true },
    })
    const name = pdfFilename(invoice?.status === 'DRAFT' ? 'DRAFT' : invoice?.number ?? 'invoice')

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        // inline, so tapping it on a phone opens a preview rather than dumping a file in
        // Downloads that the person then has to go and find
        'content-disposition': `inline; filename="${name}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not render the invoice', { status })
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
