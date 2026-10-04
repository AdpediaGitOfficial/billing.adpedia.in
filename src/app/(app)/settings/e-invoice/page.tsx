import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { eInvoiceApplicability } from '@/server/services/einvoice/applicability'
import { previewEInvoice } from '@/server/services/einvoice/register'
import { formatINR } from '@/lib/money'
import { Card, PageHeader, Alert, Pill, ProgressBar, Empty } from '@/components/ui/kit'

export default async function EInvoicePage() {
  const ctx = await requireContext()
  const a = await eInvoiceApplicability(ctx)

  // dry-run the most recent issued invoices: this is the useful part today
  const recent = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    orderBy: { date: 'desc' }, take: 10,
    select: { id: true, number: true, customer: { select: { name: true } } },
  })
  const checks = await Promise.all(recent.map(async (i) => ({
    ...i, ...(await previewEInvoice(ctx, i.id)),
  })))
  const blocked = checks.filter((c) => !c.ready)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="E-invoicing readiness"
        sub="Whether the IRP mandate applies, and whether the invoices would pass it if it did." />

      <Alert tone={a.applicable ? 'critical' : a.approaching ? 'warn' : 'good'}
        title={a.applicable ? 'E-invoicing applies' : a.approaching ? 'Approaching the threshold' : 'E-invoicing does not apply'}>
        {a.verdict}
      </Alert>

      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="eyebrow">Peak aggregate turnover</span>
          <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            threshold {formatINR(a.threshold, { decimals: false })}
          </span>
        </div>
        <ProgressBar
          value={Math.min(a.pctOfThreshold.toNumber(), 100)} max={100}
          tone={a.applicable ? 'critical' : a.approaching ? 'warn' : 'accent'}
          label={formatINR(a.peakTurnover, { decimals: false })}
          right={`${a.pctOfThreshold.toFixed(1)}%`}
        />
        <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Measured from revenue accounts across every financial year on file &mdash; invoices
          raised, not cash collected, and excluding GST, which is never the company&rsquo;s
          revenue. Liability is permanent once any year crosses: it does not lapse if a later
          year is smaller.
        </p>
      </Card>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">Turnover by year</span>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {a.years.map((y) => (
              <tr key={y.fyLabel} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="px-4 py-2.5">FY {y.fyLabel}</td>
                <td className="px-4 py-2.5 text-right tabular">{formatINR(y.turnover, { decimals: false })}</td>
                <td className="px-4 py-2.5 text-right">
                  {y.crossed ? <Pill tone="critical">over threshold</Pill> : <Pill tone="neutral">under</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">Would these invoices pass the IRP?</span>
        </div>
        {checks.length === 0 ? (
          <Empty icon="FileText" title="No issued invoices yet"
            hint="Once invoices are issued they are dry-run against the IRP schema here." />
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-4 py-2.5">
                    <Link href={`/invoices/${c.id}`} className="font-medium hover:underline">{c.number}</Link>
                    <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{c.customer.name}</span>
                    {c.issues.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {c.issues.map((i, n) => (
                          <li key={n} className="text-[11.5px]" style={{ color: 'var(--critical)' }}>
                            <span className="tabular">{i.field}</span> — {i.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {c.ready ? <Pill tone="good">would pass</Pill> : <Pill tone="critical">{c.issues.length} to fix</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {blocked.length > 0 && (
        <Alert tone="warn" title={`${blocked.length} of the last ${checks.length} invoices would be rejected`}>
          None of this blocks anything today, because the mandate does not apply. It is worth
          fixing anyway: a missing buyer GSTIN or PIN is a five-minute correction now, and a
          blocked invoice on the day the threshold is crossed.
        </Alert>
      )}

      <Card className="p-4">
        <p className="text-[14px] font-semibold">What happens if the threshold is crossed</p>
        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <li>&bull; Every B2B, SEZ and export invoice must carry an <strong>IRN obtained before it is issued</strong> — an invoice without one is not a valid tax invoice, and the buyer cannot claim the credit.</li>
          <li>&bull; HSN/SAC reporting moves from 4 digits to <strong>6</strong>.</li>
          <li>&bull; An IRN can be cancelled on the IRP for <strong>24 hours only</strong>. After that the lawful route is a credit note.</li>
          <li>&bull; B2C invoices are <strong>not eligible</strong> for an IRN at all.</li>
          <li>&bull; A GSP must be chosen and credentials configured. The adapter is written; the live client is not.</li>
        </ul>
      </Card>
    </div>
  )
}
