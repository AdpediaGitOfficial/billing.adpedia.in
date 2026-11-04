import { notFound } from 'next/navigation'
import { requireContext } from '@/server/context'
import { vendorLedger } from '@/server/services/reports/party-ledger'
import { resolvePeriod } from '@/server/services/reports/period'
import { PartyLedgerView } from '@/components/reports/party-ledger-view'

export default async function VendorLedgerPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fy?: string }>
}) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()])
  const period = await resolvePeriod(ctx.companyId, sp.fy)

  // 🔴 null means no such vendor IN THIS COMPANY — the lookup is scoped in the same query
  // that finds it, so a cross-company id is a 404 rather than a leak (docs/82 §1).
  const led = await vendorLedger(ctx, id, period)
  if (!led) notFound()

  return (
    <div className="max-w-5xl">
      <PartyLedgerView led={led} period={period}
        back={{ href: '/vendors', label: 'Vendors' }}
        csvHref={`/api/reports/export?report=vendor-ledger&party=${id}&fy=${period.fyId}`}
        periodHref={(fyId) => `/vendors/${id}/ledger?fy=${fyId}`} />
    </div>
  )
}
