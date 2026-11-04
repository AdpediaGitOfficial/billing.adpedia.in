import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import { fileError } from '@/app/api/_lib/handler'
import { resolvePeriod } from '@/server/services/reports/period'
import { trialBalance, profitAndLoss, balanceSheet } from '@/server/services/reports/statements'
import { cashFlow } from '@/server/services/reports/cash-flow'
import { receivablesAgeing, payablesAgeing } from '@/server/services/reports/ageing'
import { clientPnl } from '@/server/services/reports/client-pnl'
import {
  trialBalanceCsv, profitAndLossCsv, balanceSheetCsv, cashFlowCsv, ageingCsv, clientPnlCsv,
  journalCsv, accountLedgerCsv, partyLedgerCsv,
} from '@/server/services/reports/export'
import { journalExport } from '@/server/services/reports/journal-export'
import { accountLedger } from '@/server/services/reports/ledger'
import { clientLedger, vendorLedger } from '@/server/services/reports/party-ledger'
import { statementStanding } from '@/server/services/reports/status'

const REPORTS = [
  'trial-balance', 'pnl', 'balance-sheet', 'cash-flow', 'ageing-ar', 'ageing-ap', 'client-pnl',
  'journal', 'ledger', 'client-ledger', 'vendor-ledger',
] as const
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
    // 🔴 docs/58 — every file now says whether the books behind it are closed, locked or
    // still open. Without it a year-to-date figure reads as a final one.
    const standing = await statementStanding(ctx.companyId, period)
    const meta = { company: company.legalName, gstin: company.gstin, period: period.label, standing }

    let csv: string
    /**
     * 🔴 docs/84 — the party in the filename, SLUGIFIED, not interpolated.
     *
     * A folder of `adpedia-client-ledger-2026-27.csv` for eleven different clients is the
     * problem the comment below already names, one level in. And the name is user-entered and
     * goes into a `Content-Disposition` header, so it is reduced to letters, digits and dashes
     * first — a quote or a newline in a customer name would otherwise break the header.
     */
    let suffix = ''
    switch (which) {
      case 'trial-balance': csv = trialBalanceCsv(meta, await trialBalance(ctx, period)); break
      case 'pnl':           csv = profitAndLossCsv(meta, await profitAndLoss(ctx, period)); break
      case 'balance-sheet': csv = balanceSheetCsv(meta, await balanceSheet(ctx, period.to, period.fyStart)); break
      case 'cash-flow':     csv = cashFlowCsv(meta, await cashFlow(ctx, period)); break
      case 'ageing-ar':     csv = ageingCsv(meta, await receivablesAgeing(ctx), 'Receivables'); break
      case 'ageing-ap':     csv = ageingCsv(meta, await payablesAgeing(ctx), 'Payables'); break
      case 'client-pnl':    csv = clientPnlCsv(meta, await clientPnl(ctx, period)); break
      case 'journal':       csv = journalCsv(meta, await journalExport(ctx, period)); break
      case 'ledger': {
        const code = url.searchParams.get('account')
        if (!code) throw new AppError('Which account? Pass ?account=1100')
        const led = await accountLedger(ctx, code, period)
        if (!led) throw new AppError(`No account with code ${code}`)
        csv = accountLedgerCsv(meta, led.account, led.lines)
        break
      }
      // 🔴 docs/84 — `party` is looked UP, inside the company, before anything is read. It
      // arrives from a query string, and `clientLedger` returning null for an id belonging to
      // another company is the isolation boundary, not a convenience.
      case 'client-ledger': {
        const id = url.searchParams.get('party')
        if (!id) throw new AppError('Which customer? Pass ?party=<id>')
        const led = await clientLedger(ctx, id, period)
        if (!led) throw new AppError('No such customer')
        csv = partyLedgerCsv(meta, led)
        suffix = slug(led.party.name)
        break
      }
      case 'vendor-ledger': {
        const id = url.searchParams.get('party')
        if (!id) throw new AppError('Which vendor? Pass ?party=<id>')
        const led = await vendorLedger(ctx, id, period)
        if (!led) throw new AppError('No such vendor')
        csv = partyLedgerCsv(meta, led)
        suffix = slug(led.party.name)
        break
      }
    }

    // the filename carries the period, because a download folder full of "pnl.csv" is useless
    const account = url.searchParams.get('account')
    if (which === 'ledger' && account) suffix = slug(account)
    const name = `adpedia-${which}${suffix ? `-${suffix}` : ''}-${period.fyLabel.replace('/', '-')}.csv`
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'reports/export', 'Could not build the export')
  }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Letters, digits and dashes only — safe in a filename and in a header. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase()
}
