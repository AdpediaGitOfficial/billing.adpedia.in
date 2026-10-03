import { requireContext } from '@/server/context'
import { renderPayslipHtml } from '@/server/services/payroll/render-payslip'
import { assertMayReadPayslip } from '@/server/services/payroll/access'
import { htmlToPdf, pdfFilename } from '@/server/services/invoicing/pdf'
import { prisma } from '@/server/db'
import { AppError } from '@/server/errors'

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
    const format = new URL(req.url).searchParams.get('format')

    await assertMayReadPayslip(ctx, id)
    const html = await renderPayslipHtml(ctx.companyId, id)

    if (format === 'html') {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
      })
    }

    const slip = await prisma.payslip.findFirstOrThrow({
      where: { id },
      select: { employee: { select: { employeeCode: true } }, payrollRun: { select: { month: true, year: true } } },
    })
    const name = pdfFilename(
      `payslip-${slip.employee.employeeCode}-${slip.payrollRun.year}-${String(slip.payrollRun.month).padStart(2, '0')}`,
    )

    const pdf = await htmlToPdf(html)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${name}"`,
        // 🔴 private, not merely no-store: a payslip must never sit in a shared proxy cache
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not render the payslip', { status })
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
