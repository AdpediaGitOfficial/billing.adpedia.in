import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { renderVoucherHtml, type VoucherKind } from '@/server/services/sales/render-voucher'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { archiveIssuedDocument, archivedDocument } from '@/server/services/storage/document-archive'
import { readAttachment } from '@/server/services/storage/attachment'
import { AppError } from '@/server/errors'

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
    const entityType = kind === 'refund' ? 'RefundVoucher' : 'Receipt'

    if (format !== 'html' && url.searchParams.get('rebuild') !== '1') {
      const archived = await archivedDocument(ctx.companyId, entityType, id)
      if (archived) {
        const { bytes } = await readAttachment(ctx, archived.id)
        return new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `inline; filename="${pdfFilename(`${kind}-voucher-${id}`)}"`,
            'x-document-source': 'archived-at-issue',
            'cache-control': 'private, no-store',
          },
        })
      }
    }

    const html = await renderVoucherHtml(ctx.companyId, kind as VoucherKind, id)
    if (format === 'html') {
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-document-source': 'rebuilt-now',
          'cache-control': 'private, no-store',
        },
      })
    }

    // rendered once: the bytes archived are the bytes served
    const pdf = await htmlToPdf(html)
    const kept = await archiveIssuedDocument(ctx, {
      kind: 'VOUCHER', entityType, entityId: id,
      filename: `${kind}-voucher.pdf`, pdf,
    })

    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${pdfFilename(`${kind}-voucher-${id}`)}"`,
        'x-document-source': kept.archived ? 'archived-at-issue' : 'rebuilt-now',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not render that voucher', { status })
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
