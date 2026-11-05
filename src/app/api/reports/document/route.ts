import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { fileError } from '@/app/api/_lib/handler'
import { documentHtmlHeaders, pdfHeaders, wantsDownload } from '@/app/api/_lib/document'
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
      return new Response(html, { headers: documentHtmlHeaders() })
    }

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      // 🔴 a statement is never archived — it is a VIEW of the ledger, not a document that was
      // issued to anyone, so there is no "as issued" copy of one and it is always rebuilt now.
      headers: pdfHeaders(
        pdfFilename(`adpedia-${which}-${period.fyLabel}`),
        { download: wantsDownload(url), source: 'rebuilt-now' },
      ),
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'reports/document', 'Could not render that statement')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
