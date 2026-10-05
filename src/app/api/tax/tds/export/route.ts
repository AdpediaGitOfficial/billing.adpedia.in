import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { buildTdsReturn, tdsReturnToCsv, type ReturnForm } from '@/server/services/tax/tds-return'
import { AppError } from '@/server/errors'
import { currentFinancialYearOrThrow } from '@/server/services/accounting/period'
import { fileError } from '@/app/api/_lib/handler'

/** Deductee-wise CSV for the CA's RPU. Deliberately not an FVU file — see tds-return.ts. */
export async function GET(req: Request) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'tax', 'read')

    const url = new URL(req.url)
    const form = (url.searchParams.get('form') ?? '26Q') as ReturnForm
    const quarter = Number(url.searchParams.get('quarter') ?? '1') as 1 | 2 | 3 | 4
    if (!['24Q', '26Q', '27Q'].includes(form)) throw new AppError('Unknown form')
    if (![1, 2, 3, 4].includes(quarter)) throw new AppError('Quarter must be 1, 2, 3 or 4')

    /**
     * 🔴 docs/80 — the financial year defaults, as it does on every sibling export.
     *
     * This one took `?? ''` and handed the empty string to `findFirstOrThrow`, which threw a
     * Prisma NotFound — not an `AppError` — so the route answered 500 "Could not build the
     * return" and wrote nothing anywhere. The page always passes `fy`, so only a typed or
     * truncated URL reached it; what it cost was the one thing that would have explained it.
     */
    const fy = url.searchParams.get('fy') || (await currentFinancialYearOrThrow(ctx.companyId)).label

    const csv = tdsReturnToCsv(await buildTdsReturn(ctx, form, fy, quarter))
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="adpedia-${form}-${fy}-Q${quarter}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'tax/tds/export', 'Could not build the return')
  }
}
