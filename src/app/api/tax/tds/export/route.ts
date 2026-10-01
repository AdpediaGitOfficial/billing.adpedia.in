import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { buildTdsReturn, tdsReturnToCsv, type ReturnForm } from '@/server/services/tax/tds-return'
import { AppError } from '@/server/errors'

/** Deductee-wise CSV for the CA's RPU. Deliberately not an FVU file — see tds-return.ts. */
export async function GET(req: Request) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'tax', 'read')

    const url = new URL(req.url)
    const form = (url.searchParams.get('form') ?? '26Q') as ReturnForm
    const fy = url.searchParams.get('fy') ?? ''
    const quarter = Number(url.searchParams.get('quarter') ?? '1') as 1 | 2 | 3 | 4
    if (!['24Q', '26Q', '27Q'].includes(form)) throw new AppError('Unknown form')

    const csv = tdsReturnToCsv(await buildTdsReturn(ctx, form, fy, quarter))
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="adpedia-${form}-${fy}-Q${quarter}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not build the return', { status })
  }
}
