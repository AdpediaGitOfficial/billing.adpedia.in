import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { fileError } from '@/app/api/_lib/handler'
import { resolvePeriod } from '@/server/services/reports/period'
import { renderStatementHtml, STATEMENTS, type StatementKey } from '@/server/services/reports/render-statement'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'

/**
 * The statements as PDFs — docs/58.
 *
 * `?format=html` returns the same document as HTML, which is what the render tests assert
 * against and what makes a layout problem debuggable in a browser.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'reports', 'read')

    const url = new URL(req.url)
    const which = url.searchParams.get('statement') as StatementKey | null
    if (!which || !STATEMENTS.includes(which)) {
      throw new AppError(`Unknown statement. One of: ${STATEMENTS.join(', ')}`)
    }

    const period = await resolvePeriod(ctx.companyId, url.searchParams.get('fy') ?? undefined)
    const html = await renderStatementHtml(ctx, which, period)

    if (url.searchParams.get('format') === 'html') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
      })
    }

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${pdfFilename(`adpedia-${which}-${period.fyLabel}`)}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'reports/document', 'Could not render that statement')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
