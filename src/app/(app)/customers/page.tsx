import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listCustomers } from '@/server/services/sales/customer'
import { prisma } from '@/server/db'
import { resolveTaxMode, stateName } from '@/server/services/tax/tax-mode'
import { Card, PageHeader, Pill, Empty, Button, DataTable, type Column, tapTarget } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'
import { partyBalances } from '@/server/services/reports/party-ledger'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'

export default async function CustomersPage() {
  const ctx = await requireContext()
  /**
   * 🔴 docs/84 — the SAME boundary the ledger page uses, which is the financial year's end.
   *
   * This passed `new Date()` first, and the two disagreed on screen: the list said
   * ₹3,54,000 and the ledger it links to said ₹4,22,000, because an invoice dated later in
   * the open year counts in one and not the other. Both figures were defensible and that is
   * exactly the problem — docs/56 §2's "two balances with the same name". The ledger is a
   * financial-year statement and says so in its own tabs, so the column beside the link is
   * the same year.
   */
  const period = await resolvePeriod(ctx.companyId)
  const [customers, company, balances] = await Promise.all([
    listCustomers(ctx),
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } }),
    // one grouped query for the whole list, not one ledger per row
    partyBalances(ctx, 'CUSTOMER', period.to),
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
    { key: 'count', header: 'Invoices', width: '10%', align: 'right', mobile: false,
      cell: (r) => <span className="tabular">{r._count.invoices}</span> },
    /**
     * 🔴 docs/84 — the balance, from the ledger rather than from the invoices.
     *
     * 1100 AR net of 2400 advances held, which is what they actually owe. An invoice-table
     * sum would miss the advance and disagree with the balance sheet, and the column exists
     * precisely so the two cannot differ.
     */
    { key: 'balance', header: `Balance ${period.label}`, width: '15%', align: 'right', mobile: 'value',
      cell: (r) => {
        const b = balances.get(r.id)
        if (!b || b.isZero()) return <span style={{ color: 'var(--text-muted)' }}>—</span>
        return (
          <span className="font-semibold" style={{ color: b.lt(0) ? 'var(--good)' : undefined }}>
            {formatINR(b, { decimals: false })}
            {/* 🔴 a negative balance is an advance held — they are in credit with us, which
                is the opposite of owing and must not read as a debt */}
            {b.lt(0) && <span className="ml-1 text-[11px] font-normal">in credit</span>}
          </span>
        )
      } },
    { key: 'ledger', header: '', width: '9%', align: 'right', mobile: 'action',
      cell: (r) => (
        <Link href={`/customers/${r.id}/ledger`}
          className={`gap-1 text-[12px] font-semibold transition-colors hover:underline ${tapTarget}`}
          style={{ color: 'var(--accent)' }} title={`Ledger for ${r.name}`}>
          <Icon name="BookOpen" size={13} strokeWidth={2} /> Ledger
        </Link>
      ) },
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
