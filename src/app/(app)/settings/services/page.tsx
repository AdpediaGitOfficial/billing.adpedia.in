import { requireContext } from '@/server/context'
import { PageHeader, Alert } from '@/components/ui/kit'
import { listServiceItems, incomeAccounts } from '@/server/services/invoicing/service-item'
import { Catalogue } from './catalogue'

export default async function ServicesPage() {
  const ctx = await requireContext()
  const [rows, accounts] = await Promise.all([listServiceItems(ctx), incomeAccounts(ctx)])

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Services"
        sub="What this company sells, and the SAC code each is reported under" />

      <Alert tone="info" title="A service is a starting point, not a contract">
        An invoice line copies the name, SAC, rate and GST rate the moment it is written, and keeps its own
        copy. Changing a service here never changes an invoice already raised — which is why the catalogue
        can be corrected freely.
      </Alert>

      <Catalogue
        rows={rows.map((r) => ({
          id: r.id, name: r.name, sacCode: r.sacCode, sacTitle: r.sacTitle,
          defaultRate: r.defaultRate ? r.defaultRate.toFixed(2) : null,
          gstRatePct: r.gstRatePct.toFixed(2),
          incomeAccountId: r.incomeAccountId, incomeAccountLabel: r.incomeAccountLabel,
          isActive: r.isActive, usedOn: r.usedOn, issues: r.issues,
        }))}
        accounts={accounts.map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }))} />
    </div>
  )
}
