import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader } from '@/components/ui/kit'
import { NewCustomerForm } from './form'

export default async function NewCustomerPage() {
  const ctx = await requireContext()
  // 🔴 What this entity bills overseas clients in, set once at company setup. The form
  // offers it as the starting point; the client's own agreement overrides it.
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { billingCurrencyDefault: true },
  })

  return (
    <div className="max-w-2xl">
      <PageHeader back={{ href: '/customers', label: 'Customers' }} title="New customer" sub="Tax treatment is derived from the country and state — you never pick it." />
      <NewCustomerForm defaultCurrency={company.billingCurrencyDefault} />
    </div>
  )
}
