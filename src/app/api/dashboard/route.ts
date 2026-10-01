import { NextResponse } from 'next/server'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { dashboardSummary } from '@/server/services/dashboard'

/**
 * One round trip for the whole dashboard.
 *
 * On a phone the cost is not the database — it is latency. Eight requests over a patchy
 * 4G link is eight chances to stall; one is one. `dashboardSummary` already batches its
 * queries, so this endpoint exists purely to collapse the network side.
 *
 * 🔴 Decimal is serialised to a STRING, never a number. Sending 1234.56 as JSON turns it
 * into a float on the way out, and a float is how a rupee goes missing — which is exactly
 * what `src/lib/money.ts` exists to prevent everywhere else.
 */
export async function GET() {
  return handler(async () => {
    const ctx = await requireContext()
    const s = await dashboardSummary(ctx)
    if (!s) return { fy: null, message: 'No open financial year' }

    return {
      fy: { label: s.fy.label, startsOn: s.fy.startsOn, endsOn: s.fy.endsOn },
      money: {
        revenue: s.revenue.toFixed(2),
        invoiced: s.invoiced.toFixed(2),
        collected: s.collected.toFixed(2),
        receivable: s.receivable.toFixed(2),
        tdsCredited: s.tdsCredited.toFixed(2),
        tdsExpected: s.tdsExpected.toFixed(2),
        outputGst: s.outputGst.toFixed(2),
      },
      counts: {
        invoices: s.invoiceCount,
        openInvoices: s.openInvoices,
        overdue: s.overdueCount,
      },
      buckets: Object.fromEntries(
        Object.entries(s.buckets).map(([k, v]) => [k, (v as { toFixed(n: number): string }).toFixed(2)]),
      ),
      bank: s.bank,
      series: s.series,
      byCustomer: s.byCustomer,
      alerts: s.alerts,
    }
  })
}

/** Never cached — a stale balance presented as current is worse than no balance. */
export const dynamic = 'force-dynamic'

export function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}
