import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { assertCan, can } from '@/server/auth/permissions'
import { liveRate } from '@/server/services/fx-rates'

/**
 * docs/94 — a suggested exchange rate for the forms. Signed-in users only (it spends a call to an
 * outside service). `?currency=USD&date=2026-11-06`; no date means today. `rate` is null when
 * there is nothing to offer, and the person types one.
 */
export async function GET(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    // whoever can read invoices or bills can be offered a rate for them; an employee with only
    // their own expenses cannot spend a call to an outside service
    if (!can(ctx.role, 'invoices', 'read')) assertCan(ctx.role, 'bills', 'read')
    const u = new URL(req.url)
    const r = await liveRate(u.searchParams.get('currency') ?? '', u.searchParams.get('date') ?? undefined)
    if (!r) return { rate: null }
    return { currency: r.currency, rate: r.rate.toFixed(6), asOf: r.asOf, requested: r.requested, source: r.source, stale: r.stale }
  })
}
