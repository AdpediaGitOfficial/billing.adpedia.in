import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listVendors } from '@/server/services/purchases/vendor'
import { stateName } from '@/server/services/tax/tax-mode'
import { Card, PageHeader, Pill, Empty, Button, DataTable, Alert, type Column } from '@/components/ui/kit'

export default async function VendorsPage() {
  const ctx = await requireContext()
  const vendors = await listVendors(ctx)
  const noPan = vendors.filter((v) => v.defaultTdsSection && !v.panVerified)

  type Row = (typeof vendors)[number]
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Vendor', mobile: 'primary',
      cell: (r) => (
        <>
          <span className="block font-medium">{r.name}</span>
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.vendorType.toLowerCase().replace('_', ' ')}{r.pan && ` · ${r.entityLabel}`}
          </span>
        </>
      ) },
    { key: 'place', header: 'Place', width: '14%', mobile: 'secondary',
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.country === 'IN' ? stateName(r.stateCode) : r.country}</span> },
    { key: 'pan', header: 'PAN', width: '15%', mobile: false,
      cell: (r) => r.panVerified
        ? <span className="tabular" style={{ color: 'var(--text-muted)' }}>{r.pan}</span>
        : <Pill tone="critical" dot>missing</Pill> },
    { key: 'tds', header: 'TDS', width: '12%', align: 'center', mobile: 'tag',
      cell: (r) => r.defaultTdsSection
        ? <Pill tone={r.panVerified ? 'accent' : 'critical'}>{r.panVerified ? r.defaultTdsSection : `${r.defaultTdsSection} @20%`}</Pill>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'gst', header: 'GST', width: '14%', align: 'center', mobile: false,
      cell: (r) => r.rcmApplicable
        ? <Pill tone="warn" dot>Reverse charge</Pill>
        : r.gstin ? <Pill tone="neutral">Registered</Pill> : <Pill tone="neutral">Unregistered</Pill> },
    { key: 'bills', header: 'Bills', width: '8%', align: 'right', mobile: 'value',
      cell: (r) => <span className="tabular">{r._count.bills}</span> },
  ]

  return (
    <div>
      <PageHeader title="Vendors" sub={`${vendors.length} active`}
        action={<Link href="/vendors/new"><Button icon="Plus">New vendor</Button></Link>} />

      {noPan.length > 0 && (
        <div className="mb-5">
          <Alert tone="critical" title={`${noPan.length} ${noPan.length === 1 ? 'vendor has' : 'vendors have'} no verified PAN`}>
            Section 206AA forces TDS at 20% rather than the normal rate, and the annual threshold
            gives no relief. Collect the PAN before the next payment run — {noPan.map((v) => v.name).join(', ')}.
          </Alert>
        </div>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={vendors} keyOf={(r) => r.id}
          empty={<Empty icon="Store" title="No vendors yet"
            hint="A vendor without an Indian GSTIN is treated as an import of service — reverse charge applies and a self-invoice is generated automatically."
            action={<Link href="/vendors/new"><Button>Add the first vendor</Button></Link>} />} />
      </Card>
    </div>
  )
}
