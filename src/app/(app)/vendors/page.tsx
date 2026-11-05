import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listVendors } from '@/server/services/purchases/vendor'
import { stateName } from '@/server/services/tax/tax-mode'
import { partyBalances } from '@/server/services/reports/party-ledger'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR } from '@/lib/money'
import { countryName } from '@/lib/countries'
import { Icon } from '@/components/shell/icon'
import { Card, PageHeader, Pill, Empty, Button, DataTable, Alert, type Column, tapTarget } from '@/components/ui/kit'

export default async function VendorsPage() {
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
  // one grouped query for the whole list, not one ledger per row
  const [vendors, balances] = await Promise.all([listVendors(ctx), partyBalances(ctx, 'VENDOR', period.to)])
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
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.country === 'IN' ? stateName(r.stateCode) : countryName(r.country)}</span> },
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
    { key: 'bills', header: 'Bills', width: '8%', align: 'right', mobile: false,
      cell: (r) => <span className="tabular">{r._count.bills}</span> },
    /**
     * 🔴 docs/84 — 2000 AP for this vendor, net of the TDS already withheld.
     *
     * `postTdsDeduction` debits AP and credits 2210/2220/2230 as its own entry, so a
     * ₹1,00,000 bill with ₹10,000 deducted shows ₹90,000 here — which is what will actually
     * be paid. A figure taken from the bill table would say ₹1,00,000 and the payment would
     * never match it.
     */
    { key: 'balance', header: `Payable ${period.label}`, width: '15%', align: 'right', mobile: 'value',
      cell: (r) => {
        const b = balances.get(r.id)
        if (!b || b.isZero()) return <span style={{ color: 'var(--text-muted)' }}>—</span>
        return (
          <span className="font-semibold" style={{ color: b.lt(0) ? 'var(--good)' : undefined }}>
            {formatINR(b, { decimals: false })}
            {/* a negative payable is an advance paid to them — ours to recover, not owed */}
            {b.lt(0) && <span className="ml-1 text-[11px] font-normal">advanced</span>}
          </span>
        )
      } },
    { key: 'ledger', header: '', width: '9%', align: 'right', mobile: 'action',
      cell: (r) => (
        <Link href={`/vendors/${r.id}/ledger`}
          className={`gap-1 text-[12px] font-semibold transition-colors hover:underline ${tapTarget}`}
          style={{ color: 'var(--accent)' }} title={`Ledger for ${r.name}`}>
          <Icon name="BookOpen" size={13} strokeWidth={2} /> Ledger
        </Link>
      ) },
    /**
     * 🔴 docs/84 — `'action'`, not `false`. This table has no `onRowHref` either, so with the
     * column hidden there was no way to reach the edit page from a phone at all — docs/68 §5's
     * defect exactly, which the guard could not see because its pattern knew about buttons and
     * not about links.
     */
    { key: 'edit', header: '', width: '8%', align: 'right', mobile: 'action',
      cell: (r) => (
        <Link href={`/vendors/${r.id}/edit`}
          className={`text-[12px] underline underline-offset-2 ${tapTarget}`}
          style={{ color: 'var(--accent)' }}>edit</Link>
      ) },
  ]

  return (
    <div>
      <PageHeader title="Vendors" sub={`${vendors.length} active`}
        action={<Link href="/vendors/new"><Button icon="Plus">New vendor</Button></Link>} />

      {noPan.length > 0 && (
        <div className="mb-5">
          {/* docs/47 — "no PAN on file", not "unverified": s.206AA turns on whether the
              payee furnished one, and this system does not check PANs online. */}
          <Alert tone="critical" title={`${noPan.length} ${noPan.length === 1 ? 'vendor has' : 'vendors have'} no PAN on file`}>
            Section 206AA forces TDS at 20% rather than the normal rate, and the annual threshold
            gives no relief. Collect the PAN before the next payment run — {noPan.map((v) => v.name).join(', ')}.
            Record it in the <Link href="/tax/pan" className="underline underline-offset-2">PAN register</Link>,
            where the card can be filed with it.
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
