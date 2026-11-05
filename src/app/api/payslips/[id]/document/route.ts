import { requireContext } from '@/server/context'
import { renderPayslipHtml } from '@/server/services/payroll/render-payslip'
import { assertMayReadPayslip } from '@/server/services/payroll/access'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { prisma } from '@/server/db'
import { fileError } from '@/app/api/_lib/handler'
import { documentHtmlHeaders, pdfHeaders, wantsDownload } from '@/app/api/_lib/document'
import { archiveIssuedDocument, archivedDocumentBytes } from '@/server/services/storage/document-archive'

/**
 * The payslip document — docs/57.
 *
 * 🔴 The only route in this system where WHO is asking decides the answer. `requireContext()`
 * proves the reader is signed in to this company, which is all an invoice needs; a payslip
 * needs more, so `assertMayReadPayslip` runs before anything is rendered.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    const { id } = await params
    const url = new URL(req.url)
    const format = url.searchParams.get('format')
    const download = wantsDownload(url)

    await assertMayReadPayslip(ctx, id)

    const slip = await prisma.payslip.findFirstOrThrow({
      where: { id },
      select: { employee: { select: { employeeCode: true } }, payrollRun: { select: { month: true, year: true } } },
    })
    const name = pdfFilename(
      `payslip-${slip.employee.employeeCode}-${slip.payrollRun.year}-${String(slip.payrollRun.month).padStart(2, '0')}`,
    )

    /**
     * 🔴 docs/59 — a payslip is issued when it is HANDED OVER, which is this request.
     *
     * An invoice has a moment of issue in the system; a payslip does not — approving a run
     * does not give anybody their slip. So the first download is the issue, and the bytes
     * served then are archived and served again ever after. What the employee holds and what
     * this system can produce are the same file, which is the whole point: docs/57 §6 noted
     * that a reprint otherwise reflects the employee record as it is today.
     */
    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const bytes = await archivedDocumentBytes(ctx, 'Payslip', id)
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: pdfHeaders(name, { download, source: 'archived-at-issue' }),
        })
      }
    }

    const html = await renderPayslipHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: documentHtmlHeaders(),
      })
    }

    // rendered ONCE: the bytes archived are the bytes served
    const pdf = await htmlToPdf(html)
    const kept = await archiveIssuedDocument(ctx, {
      kind: 'PAYSLIP', entityType: 'Payslip', entityId: id, filename: name, pdf,
    })

    return new Response(new Uint8Array(pdf), {
      headers: pdfHeaders(name, { download, source: kept.archived ? 'archived-at-issue' : 'rebuilt-now' }),
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'payslips/[id]/document', 'Could not render the payslip')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
