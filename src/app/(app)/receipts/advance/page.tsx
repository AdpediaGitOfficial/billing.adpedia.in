import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader, Card } from '@/components/ui/kit'
import { AdvanceForm } from './form'

export default async function NewAdvancePage() {
  const ctx = await requireContext()
  const customers = await prisma.customer.findMany({
    where: { companyId: ctx.companyId },
    select: { id: true, name: true, stateCode: true, country: true },
    orderBy: { name: 'asc' },
  })

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Advance received"
        sub="Money in before an invoice exists — a receipt voucher under s.31(3)(d), not a tax invoice" />

      <Card className="p-4">
        <p className="eyebrow">Why this is not just a receipt</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Nothing has been supplied yet, so the money is a <strong>liability</strong> rather than revenue — and
          the GST on it still falls due now, because s.13(2) fixes the time of supply for services as the
          earlier of the invoice and the payment. When the invoice finally covers it, the advance is absorbed
          and the tax it paid is reversed, so the same supply is never taxed twice.
        </p>
      </Card>

      <AdvanceForm customers={customers} today={new Date().toISOString().slice(0, 10)} />
    </div>
  )
}
