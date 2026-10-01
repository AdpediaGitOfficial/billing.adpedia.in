import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { listLuts } from '@/server/services/invoicing/lut'
import { Card, CardHeader, PageHeader, Pill, Alert, Empty } from '@/components/ui/kit'
import { LutForm } from './form'

export default async function LutPage() {
  const ctx = await requireContext()
  const [luts, fy, exportCustomers] = await Promise.all([
    listLuts(ctx),
    prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' } }),
    prisma.customer.count({ where: { companyId: ctx.companyId, country: { not: 'IN' }, isActive: true } }),
  ])
  const current = luts.find((l) => l.fyLabel === fy?.label)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="LUT register"
        sub="A Letter of Undertaking lets exports be zero-rated without paying IGST. It is valid for one financial year and must be re-filed every March." />

      {fy && !current && (
        <Alert tone={exportCustomers > 0 ? 'critical' : 'warn'} title={`No LUT for FY ${fy.label}`}>
          {exportCustomers > 0
            ? `${exportCustomers} overseas ${exportCustomers === 1 ? 'customer is' : 'customers are'} on record. Export invoices are blocked at send until Form RFD-11 is filed — or raise them with payment of IGST and claim the refund.`
            : 'Nothing is blocked today because there are no overseas customers, but file RFD-11 before the first export invoice.'}
        </Alert>
      )}

      <Card>
        <CardHeader title="Add a LUT" sub="The ARN is checked against the state and the financial year it actually covers." />
        <LutForm defaultFy={fy?.label ?? ''} />
      </Card>

      <Card flush className="overflow-hidden">
        <CardHeader title="On file" className="p-5 pb-4" sub={`${luts.length} recorded`} />
        {luts.length === 0 ? (
          <Empty icon="FileCheck" title="No LUTs recorded" hint="Add the ARN from the GST portal — Services → User Services → View My Submitted LUTs." />
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {luts.map((l) => {
              const isCurrent = l.fyLabel === fy?.label
              const expired = fy ? l.fyLabel < fy.label : false
              return (
                <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div>
                    <p className="text-[13.5px] font-semibold tabular">{l.arn}</p>
                    <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      FY {l.fyLabel} · {l.validFrom.toISOString().slice(0, 10)} to {l.validTo.toISOString().slice(0, 10)}
                      {l.filedOn && ` · filed ${l.filedOn.toISOString().slice(0, 10)}`}
                    </p>
                  </div>
                  <Pill dot tone={isCurrent ? 'good' : expired ? 'neutral' : 'accent'}>
                    {isCurrent ? 'Current year' : expired ? 'Expired' : 'Future'}
                  </Pill>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
