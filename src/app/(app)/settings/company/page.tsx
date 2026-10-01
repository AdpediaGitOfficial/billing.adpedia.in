import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Card, PageHeader, Pill, Alert } from '@/components/ui/kit'

interface Addr { line1?: string; line2?: string; city?: string; state?: string; pincode?: string; country?: string }

export default async function CompanySettingsPage() {
  const ctx = await requireContext()
  const co = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    include: {
      bankAccounts: { orderBy: { isDefault: 'desc' } },
      financialYears: { orderBy: { startsOn: 'desc' } },
      series: { orderBy: { docType: 'asc' } },
    },
  })
  const addr = (co.registeredAddress ?? {}) as Addr

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Company"
        sub="The registered identity every invoice, return and challan is issued under." />

      <Alert tone="info" title="Read-only for now">
        These are the verified details from the PAN card, GST REG-06 and the MCA incorporation
        certificate. Editing them changes what appears on documents already issued, so it is
        deliberately not wired up yet — tell me what needs correcting and it becomes a migration
        with an audit trail, not a text box.
      </Alert>

      <Card flush className="overflow-hidden">
        <Section title="Identity" />
        <table className="w-full text-[13px]">
          <tbody>
            <Row k="Legal name" v={co.legalName} />
            {co.tradeName && co.tradeName !== co.legalName && <Row k="Trade name" v={co.tradeName} />}
            <Row k="PAN" v={co.pan} mono />
            <Row k="GSTIN" v={co.gstin ?? '—'} mono />
            <Row k="TAN" v={co.tan ?? '—'} mono note={co.tan ? 'verify — partly clipped in the source document' : undefined} />
            <Row k="CIN" v={co.cin ?? '—'} mono />
            <Row k="State" v={`${co.stateCode} — drives CGST+SGST vs IGST`} />
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <Section title="Registered address" />
        <table className="w-full text-[13px]">
          <tbody>
            <Row k="Address" v={[addr.line1, addr.line2, addr.city, addr.state, addr.pincode, addr.country].filter(Boolean).join(', ')} />
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <Section title="Bank accounts" />
        <table className="w-full text-[13px]">
          <tbody>
            {co.bankAccounts.map((b) => (
              <tr key={b.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5">
                  <span className="font-medium">{b.label}</span>
                  <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {b.bankName} · {b.branch}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="tabular">{b.accountNo}</span>
                  <span className="block text-[11.5px] tabular" style={{ color: 'var(--text-muted)' }}>{b.ifsc}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {b.isDefault && <Pill tone="good">default</Pill>}
                  {b.showOnInvoice && <Pill tone="neutral">on invoice</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <Section title="Financial years" />
        <table className="w-full text-[13px]">
          <tbody>
            {co.financialYears.map((fy) => (
              <tr key={fy.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5 font-medium">FY {fy.label}</td>
                <td className="px-4 py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>
                  {fy.startsOn.toISOString().slice(0, 10)} → {fy.endsOn.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Pill tone={fy.status === 'OPEN' ? 'good' : 'neutral'}>{fy.status.toLowerCase()}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <Section title="Document numbering" />
        <table className="w-full text-[13px]">
          <tbody>
            {co.series.map((s) => (
              <tr key={s.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5">{s.docType.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="px-4 py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>{s.pattern}</td>
                <td className="px-4 py-2.5 text-right tabular">next #{s.nextSeq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <p className="eyebrow">Related</p>
        <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          <Link href="/settings/lut" className="underline">LUT register</Link> ·{' '}
          <Link href="/settings/e-invoice" className="underline">E-invoicing readiness</Link> ·{' '}
          <Link href="/tax/pan" className="underline">PAN register</Link>
        </p>
      </Card>
    </div>
  )
}

function Section({ title }: { title: string }) {
  return (
    <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
      <span className="eyebrow">{title}</span>
    </div>
  )
}

function Row({ k, v, mono, note }: { k: string; v: string; mono?: boolean; note?: string }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--rule)' }}>
      <td className="px-4 py-2.5 w-[35%]" style={{ color: 'var(--text-muted)' }}>{k}</td>
      <td className="px-4 py-2.5">
        <span className={mono ? 'tabular font-medium' : 'font-medium'}>{v}</span>
        {note && <span className="block text-[11.5px]" style={{ color: 'var(--warn)' }}>⚠ {note}</span>}
      </td>
    </tr>
  )
}
