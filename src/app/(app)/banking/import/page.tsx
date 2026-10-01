import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, Pill, Alert, Empty } from '@/components/ui/kit'
import { ImportForm } from './form'

export default async function ImportPage() {
  const ctx = await requireContext()
  const [accounts, imports] = await Promise.all([
    prisma.companyBankAccount.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { isDefault: 'desc' } }),
    prisma.bankStatementImport.findMany({ where: { companyId: ctx.companyId }, orderBy: { importedAt: 'desc' }, take: 10 }),
  ])

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Import statement" sub="CSV or tab-delimited, exported from internet banking" />

      <Alert tone="info" title="Export as CSV, not PDF">
        A PDF statement&rsquo;s text layer interleaves the columns — names wrap across the column
        boundary and any parser mis-attributes them. Axis internet banking exports the same
        statement as .xls or .csv; use that.
      </Alert>

      <Card>
        <CardHeader title="Paste the rows" sub="The opening and closing balances are read from the file when present." />
        <ImportForm accounts={accounts.map((a) => ({ id: a.id, label: a.label, accountNo: a.accountNo }))} />
      </Card>

      <Card flush className="overflow-hidden">
        <CardHeader title="Previous imports" className="p-5 pb-4" />
        {imports.length === 0 ? (
          <Empty icon="Upload" title="Nothing imported yet" />
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {imports.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div>
                  <p className="text-[13.5px] font-medium">{i.fileName}</p>
                  <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {i.periodFrom.toISOString().slice(0, 10)} to {i.periodTo.toISOString().slice(0, 10)} ·
                    {' '}{i.rowsImported} imported{i.rowsDuplicate > 0 && `, ${i.rowsDuplicate} duplicate`} ·
                    {' '}closing {formatINR(i.closingBalance.toString())}
                  </p>
                </div>
                <Pill dot tone={i.balanceCheckOk ? 'good' : 'critical'}>
                  {i.balanceCheckOk ? 'balances agree' : 'balance check failed'}
                </Pill>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
