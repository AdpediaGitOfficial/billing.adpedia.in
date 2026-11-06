import { CONSTITUTION_LABEL } from '@/lib/constitution'
import { requireContext } from '@/server/context'
import { can } from '@/server/auth/permissions'
import { Card, PageHeader, Pill, Alert } from '@/components/ui/kit'
import { myCompanies } from '@/server/services/company/switch'
import { SwitchButton } from './switch-button'
import { CreateCompanyForm } from './create-form'

export default async function CompaniesPage() {
  const ctx = await requireContext()
  const companies = await myCompanies(ctx)
  const mayCreate = can(ctx.role, 'settings.company', 'write')

  return (
    <div>
      <PageHeader
        title="Companies"
        sub="Separate entities, separate books. Nothing here is ever added together."
      />

      {/*
        🔴 docs/82 — two entities under one login are two TAXPAYERS. The thing a person has to
        be able to see at a glance is which books they are in, because the screens are otherwise
        identical and an invoice raised in the wrong one is numbered from that entity's series,
        posted to its ledger and frozen on send.
      */}
      <Card className="mb-4 divide-y" flush>
        {companies.map((c) => (
          <div key={c.companyId} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[14px] font-medium">{c.legalName}</p>
                {c.current && <Pill tone="accent">you are here</Pill>}
              </div>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {CONSTITUTION_LABEL[c.constitution]} · {c.gstin ?? 'not GST registered'} ·{' '}
                {c.role.replace('_', ' ').toLowerCase()}
              </p>
            </div>
            {!c.current && <SwitchButton companyId={c.companyId} legalName={c.legalName} />}
          </div>
        ))}
      </Card>

      {companies.length > 1 && (
        <Alert tone="warn" title="These are different taxpayers">
          Each entity files its own returns on its own PAN, and income is taxed in different
          hands. There is no combined report anywhere in this system, and there should not be —
          no figure is legitimately the sum of two taxpayers.
        </Alert>
      )}

      {mayCreate && (
        <Card className="mt-4 p-4">
          <p className="eyebrow mb-3">Add another entity</p>
          <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            It is created complete — its own chart of accounts, financial year and document
            series — so it can raise its first invoice immediately. A personal account is for your
            own freelance income and invoices: no GST, no company filings, and capital and drawings
            instead of share capital, which is how personal spending is recorded without touching
            taxable profit.
          </p>
          <CreateCompanyForm />
        </Card>
      )}
    </div>
  )
}
