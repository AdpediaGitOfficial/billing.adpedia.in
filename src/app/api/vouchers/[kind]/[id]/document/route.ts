import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { renderVoucherHtml, type VoucherKind } from '@/server/services/sales/render-voucher'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { archiveIssuedDocument, archivedDocumentBytes } from '@/server/services/storage/document-archive'
import { AppError } from '@/server/errors'
import { fileError } from '@/app/api/_lib/handler'
import { documentHtmlHeaders, pdfHeaders, wantsDownload } from '@/app/api/_lib/document'

const KINDS: VoucherKind[] = ['receipt', 'refund']

/**
 * The two advance vouchers — docs/65.
 *
 * 🔴 Archived on first download, like the payslip in docs/59: a receipt voucher has no
 * separate issuing step, so handing it over IS the issue. A refund voucher is archived the
 * same way for the same reason.
 */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'receipts', 'read')

    const { kind, id } = await params
    if (!KINDS.includes(kind as VoucherKind)) {
      throw new AppError(`Unknown voucher. One of: ${KINDS.join(', ')}`)
    }
    const url = new URL(req.url)
    const format = url.searchParams.get('format')
    const download = wantsDownload(url)
    const entityType = kind === 'refund' ? 'RefundVoucher' : 'Receipt'
    const name = pdfFilename(`${kind}-voucher-${id}`)

    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const bytes = await archivedDocumentBytes(ctx, entityType, id)
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: pdfHeaders(name, { download, source: 'archived-at-issue' }),
        })
      }
    }

    const html = await renderVoucherHtml(ctx.companyId, kind as VoucherKind, id)
    if (format === 'html') {
      return new Response(html, {
        headers: documentHtmlHeaders(),
      })
    }

    // rendered once: the bytes archived are the bytes served
    const pdf = await htmlToPdf(html)
    const kept = await archiveIssuedDocument(ctx, {
      kind: 'VOUCHER', entityType, entityId: id,
      filename: `${kind}-voucher.pdf`, pdf,
    })

    return new Response(new Uint8Array(pdf), {
      headers: pdfHeaders(name, { download, source: kept.archived ? 'archived-at-issue' : 'rebuilt-now' }),
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'vouchers/[kind]/[id]/document', 'Could not render that voucher')
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
