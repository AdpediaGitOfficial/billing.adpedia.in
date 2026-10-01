import { requireContext } from '@/server/context'
import { panRegister } from '@/server/services/tax/pan-register'
import { formatINR } from '@/lib/money'
import { PageHeader, Card, Alert } from '@/components/ui/kit'
import { PanForms } from './forms'

export default async function PanPage() {
  const ctx = await requireContext()
  const reg = await panRegister(ctx)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="PAN register"
        sub="Every person Adpedia deducts tax from. Without a PAN, s.206AA forces 20%." />

      {reg.missing > 0 && (
        <Alert tone="critical" title={`${reg.missing} of ${reg.rows.length} have no PAN on file`}>
          Section 206AA applies <strong>20%</strong> where a PAN is missing — double the 194J rate
          and twenty times the 194C individual rate. The money is not lost, but the payee only
          gets it back by filing a return and waiting for a refund.
          {reg.totalExcessWithheld.gt(0) && (
            <> So far that is <strong>{formatINR(reg.totalExcessWithheld)}</strong> withheld in excess this year.</>
          )}
        </Alert>
      )}

      {reg.duplicated > 0 && (
        <Alert tone="critical" title="The same PAN is on file for more than one person">
          One of them is wrong, or the same person is recorded twice. Either way the 26Q return
          aggregates their payments under one deductee and the thresholds are computed against
          the wrong total.
        </Alert>
      )}

      <Alert tone="info" title="A valid-looking PAN is not a verified PAN">
        Everything here checks <em>format</em>. Only the Income Tax portal&rsquo;s bulk PAN
        verification can confirm that a PAN exists and whose it is &mdash; and quoting a wrong but
        well-formed PAN is worse than quoting none: the deduction is reported against a stranger,
        the real payee never sees it in their 26AS, and fixing it needs a revised return.
      </Alert>

      <PanForms rows={reg.rows.map((r) => ({
        kind: r.kind, id: r.id, name: r.name, pan: r.pan,
        section: r.section, verified: r.verified,
        effective: r.effectiveRatePct.toFixed(0),
        correct: r.correctRatePct.toFixed(0),
        paid: r.paidThisFy.toFixed(2),
        excess: r.excessWithheld.toFixed(2),
        issues: r.issues,
      }))} />

      <Card className="p-4">
        <p className="text-[14px] font-semibold">Why this matters beyond the rate</p>
        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <li>&bull; <strong>Form 16 / 16A cannot be issued</strong> without a PAN, so the payee has no proof of the deduction.</li>
          <li>&bull; The deduction never reaches their <strong>Form 26AS</strong>, so they cannot claim it.</li>
          <li>&bull; A 26Q filed with missing or invalid PANs attracts a <strong>short-deduction demand</strong> on TRACES.</li>
          <li>&bull; The 4th character decides <strong>194C at 1% or 2%</strong> — it is the only reliable source for that.</li>
        </ul>
      </Card>
    </div>
  )
}
