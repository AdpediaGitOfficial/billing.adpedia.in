import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { resolvePeriod } from '@/server/services/reports/period'
import { trialBalance, profitAndLoss, balanceSheet } from '@/server/services/reports/statements'
import { cashFlow } from '@/server/services/reports/cash-flow'
import { receivablesAgeing, payablesAgeing } from '@/server/services/reports/ageing'
import { clientPnl } from '@/server/services/reports/client-pnl'
import {
  trialBalanceCsv, profitAndLossCsv, balanceSheetCsv, cashFlowCsv, ageingCsv, clientPnlCsv,
} from '@/server/services/reports/export'

const REPORTS = ['trial-balance', 'pnl', 'balance-sheet', 'cash-flow', 'ageing-ar', 'ageing-ap', 'client-pnl'] as const
type ReportKey = (typeof REPORTS)[number]

export async function GET(req: Request) {
  try {
    const ctx = await requireContext()
    assertCan(ctx.role, 'reports', 'read')

    const url = new URL(req.url)
    const which = url.searchParams.get('report') as ReportKey | null
    if (!which || !REPORTS.includes(which)) {
      throw new AppError(`Unknown report. One of: ${REPORTS.join(', ')}`)
    }

    const [company, period] = await Promise.all([
      prisma.company.findUniqueOrThrow({
        where: { id: ctx.companyId }, select: { legalName: true, gstin: true },
      }),
      resolvePeriod(ctx.companyId, url.searchParams.get('fy') ?? undefined),
    ])
    const meta = { company: company.legalName, gstin: company.gstin, period: period.label }

    let csv: string
    switch (which) {
      case 'trial-balance': csv = trialBalanceCsv(meta, await trialBalance(ctx, period)); break
      case 'pnl':           csv = profitAndLossCsv(meta, await profitAndLoss(ctx, period)); break
      case 'balance-sheet': csv = balanceSheetCsv(meta, await balanceSheet(ctx, period.to, period.fyStart)); break
      case 'cash-flow':     csv = cashFlowCsv(meta, await cashFlow(ctx, period)); break
      case 'ageing-ar':     csv = ageingCsv(meta, await receivablesAgeing(ctx), 'Receivables'); break
      case 'ageing-ap':     csv = ageingCsv(meta, await payablesAgeing(ctx), 'Payables'); break
      case 'client-pnl':    csv = clientPnlCsv(meta, await clientPnl(ctx, period)); break
    }

    // the filename carries the period, because a download folder full of "pnl.csv" is useless
    const name = `adpedia-${which}-${period.fyLabel.replace('/', '-')}.csv`
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not build the export', { status })
  }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
