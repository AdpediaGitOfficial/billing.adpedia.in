import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listCustomers } from '@/server/services/sales/customer'
import { prisma } from '@/server/db'
import { resolveTaxMode, stateName } from '@/server/services/tax/tax-mode'
import { Card, PageHeader, Pill, Empty, Button, DataTable, type Column } from '@/components/ui/kit'

export default async function CustomersPage() {
  const ctx = await requireContext()
  const [customers, company] = await Promise.all([
    listCustomers(ctx),
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } }),
  ])

  type Row = (typeof customers)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Customer', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.name}</span>
          {r.contactPerson && <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.contactPerson}</span>}
        </>
      ) },
    { key: 'place', header: 'Place of supply', width: '18%', mobile: 'secondary',
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.country === 'IN' ? stateName(r.stateCode) : r.country}</span> },
    { key: 'gstin', header: 'GSTIN', width: '18%', mobile: false,
      cell: (r) => <span className="tabular" style={{ color: 'var(--text-muted)' }}>{r.gstin ?? '—'}</span> },
    { key: 'tax', header: 'Tax treatment', width: '18%', align: 'center', mobile: 'tag',
      cell: (r) => {
        const mode = resolveTaxMode({ stateCode: company.stateCode },
          { country: r.country, stateCode: r.stateCode, customerType: r.customerType })
        return <Pill tone={mode === 'EXPORT' ? 'warn' : mode === 'INTRA' ? 'accent' : 'info'}>
          {mode === 'INTRA' ? 'CGST + SGST' : mode === 'INTER' ? 'IGST' : 'Zero-rated'}
        </Pill>
      } },
    { key: 'tds', header: 'Deducts TDS', width: '12%', align: 'center', mobile: false,
      cell: (r) => r.defaultTdsSection ? <Pill tone="neutral">{r.defaultTdsSection}</Pill> : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'count', header: 'Invoices', width: '10%', align: 'right', mobile: 'value',
      cell: (r) => <span className="tabular">{r._count.invoices}</span> },
  ]

  return (
    <div>
      <PageHeader title="Customers" sub={`${customers.length} active`}
        action={<Link href="/customers/new"><Button icon="Plus">New customer</Button></Link>} />
      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={customers} keyOf={(r) => r.id} onRowHref={(r) => `/customers/${r.id}`}
          empty={<Empty icon="Users" title="No customers yet"
            hint="Add one and the tax treatment follows automatically — Kerala gets CGST+SGST, other states IGST, overseas is zero-rated under LUT."
            action={<Link href="/customers/new"><Button>Add the first customer</Button></Link>} />} />
      </Card>
    </div>
  )
}
