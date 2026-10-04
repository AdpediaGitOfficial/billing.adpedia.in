import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Card, PageHeader, Pill, Alert } from '@/components/ui/kit'
import { CompanyEditForm } from './edit-form'
import { RocForm } from './roc-form'
import { rocYears } from '@/server/services/compliance/roc'
import { gstr9Due, itrDue } from '@/server/services/compliance/deadlines'

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
  // docs/72 — the registrar's dates, for every year that has ended
  const roc = await rocYears(ctx)
  const iso = (d: Date | null | undefined) => d ? d.toISOString().slice(0, 10) : ''

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Company"
        sub="The registered identity every invoice, return and challan is issued under." />

      {/* 🔴 docs/67 — docs/35 §6 refused to wire this up because editing company identity
          "changes what appears on documents already issued". docs/59 archives every issued
          document as the bytes that went out, so that is no longer true of the details below.
          It is still true of the five fields in the next card, which is why they are not here. */}
      <Alert tone="info" title="Correcting these is safe; the identity below is not">
        These came from the PAN card, GST REG-06 and the MCA certificate. Every invoice, note and payslip
        is now kept as the exact file that went out, so correcting an address today cannot rewrite one a
        client received in May — and every change is recorded in the audit log, with what it was before.
      </Alert>

      <Card className="p-4">
        <p className="eyebrow">Contact and address</p>
        <div className="mt-3">
          <CompanyEditForm initial={{
            tradeName: co.tradeName ?? '', tan: co.tan ?? '',
            email: co.email ?? '', phone: co.phone ?? '', website: co.website ?? '',
            addressLine1: addr.line1 ?? '', addressLine2: addr.line2 ?? '',
            city: addr.city ?? '', state: addr.state ?? '', pincode: addr.pincode ?? '',
            country: addr.country ?? 'India',
          }} />
        </div>
      </Card>

      <Card flush className="overflow-hidden">
        {/* 🔴 TAN and the trade name moved into the editable card above — leaving them here
            under a heading reading "fixed" said two things on one screen. The five below are
            fixed for a reason each, and the reason is on the row. */}
        <Section title="Identity — fixed" />
        <table className="w-full text-[13px]">
          <tbody>
            <Row k="Legal name" v={co.legalName} why="the invoice series and every filed return are issued under it" />
            <Row k="PAN" v={co.pan} mono why="quoted in every TDS return and challan" />
            <Row k="GSTIN" v={co.gstin ?? '—'} mono why="changing it would make GSTR-1 disagree with the portal" />
            <Row k="CIN" v={co.cin ?? '—'} mono why="from the MCA incorporation certificate" />
            <Row k="State" v={co.stateCode} why="derives CGST+SGST vs IGST on every future invoice" />
          </tbody>
        </table>
        <p className="px-5 pb-4 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          A genuine change to any of these is a new registration or a rectification, not a correction —
          it wants the CA and a migration, because the figures already filed were filed under them.
        </p>
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

      {roc.length > 0 && (
        <Card flush className="overflow-hidden">
          <Section title="Annual filings" />
          <p className="px-4 pt-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Everything about a year that has <em>ended</em>, and none of it on a portal this system talks to —
            so each is recorded here, because an annual item with nothing able to clear it nags for ever once
            its date passes. AOC-4 and MGT-7 run from the date the AGM was <em>held</em> — thirty days and sixty under
            s.137(1) and s.92(4) — not from the 30 September it could have been held by. A meeting held
            early makes both forms due early. Late costs ₹100 a day, per form, with no upper limit since
            the 2018 amendment to s.403.
          </p>
          <div className="space-y-6 p-4">
            {roc.map((y) => (
              <div key={y.id}>
                <p className="mb-2 text-[12.5px] font-semibold">FY {y.label}</p>
                <RocForm year={{
                  id: y.id,
                  label: y.label,
                  agmLimit: y.agmLimit.toISOString().slice(0, 10),
                  agmHeldOn: iso(y.agmHeldOn),
                  agmSource: y.agmSource ?? '',
                  aoc4FiledOn: iso(y.aoc4FiledOn),
                  mgt7FiledOn: iso(y.mgt7FiledOn),
                  gstr9FiledOn: iso(y.gstr9FiledOn),
                  gstr9Arn: y.gstr9Arn ?? '',
                  gstr9Due: iso(gstr9Due(y.startsOn.getUTCFullYear())),
                  itrFiledOn: iso(y.itrFiledOn),
                  itrAckNo: y.itrAckNo ?? '',
                  itrDue: iso(itrDue(y.startsOn.getUTCFullYear())),
                }} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <p className="eyebrow">Related</p>
        <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          <Link href="/settings/lut" className="underline">LUT register</Link> ·{' '}
          <Link href="/settings/e-invoice" className="underline">E-invoicing readiness</Link> ·{' '}
          <Link href="/tax/pan" className="underline">PAN register</Link> ·{' '}
          <Link href="/tax/calendar" className="underline">Compliance calendar</Link>
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

/**
 * 🔴 `note` is a warning and `why` is an explanation, and they must not share a style.
 *
 * Every row in the fixed-identity card carries a reason it cannot be edited. Rendered through
 * `note` they all came out amber with a ⚠, which turns five ordinary explanations into five
 * problems — and leaves the one real warning on this page indistinguishable from them.
 */
function Row({ k, v, mono, note, why }: { k: string; v: string; mono?: boolean; note?: string; why?: string }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--rule)' }}>
      <td className="px-4 py-2.5 w-[35%]" style={{ color: 'var(--text-muted)' }}>{k}</td>
      <td className="px-4 py-2.5">
        <span className={mono ? 'tabular font-medium' : 'font-medium'}>{v}</span>
        {note && <span className="block text-[11.5px]" style={{ color: 'var(--warn)' }}>⚠ {note}</span>}
        {why && <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{why}</span>}
      </td>
    </tr>
  )
}
