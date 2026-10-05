import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { assertCan } from '@/server/auth/permissions'
import { periodsInFy, periodFor } from '@/server/services/tax/periods'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { buildGstr3b } from '@/server/services/tax/gstr3b'
import { gstr1ToCsv, gstr3bToCsv } from '@/server/services/tax/gst-export'
import { fileError } from '@/app/api/_lib/handler'
import { currentFinancialYearOrThrow } from '@/server/services/accounting/period'

/** CSV for the CA. Deliberately not a portal payload — see gstr1.ts. */
export async function GET(req: Request) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'tax', 'read')

    const url = new URL(req.url)
    const which = url.searchParams.get('return') === 'gstr3b' ? 'gstr3b' : 'gstr1'
    const label = url.searchParams.get('period')

    const [company, fy] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
      currentFinancialYearOrThrow(ctx.companyId),
    ])
    const all = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
    const period = all.find((p) => p.label === label) ?? periodFor(new Date(), company.gstFilingFrequency)

    const csv = which === 'gstr3b'
      ? gstr3bToCsv(await buildGstr3b(ctx.companyId, period.from, period.to, period.label))
      : gstr1ToCsv(await buildGstr1(ctx.companyId, period.from, period.to, period.label))

    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="adpedia-${which}-${period.label}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'tax/gst/export', 'Could not build the export')
  }
}
