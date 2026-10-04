import { requireContext } from '@/server/context'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty } from '@/components/ui/kit'
import { documentSeriesRegister, seriesLabel } from '@/server/services/invoicing/series-register'

export default async function SeriesPage() {
  const ctx = await requireContext()
  const reg = await documentSeriesRegister(ctx)

  const patternProblems = reg.rows.filter((r) => r.patternProblem)
  const issued = reg.rows.reduce((a, r) => a + r.issued, 0)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Document series"
        sub={`FY ${reg.fyLabel} · every number this system has issued, and anything missing from the run`} />

      <Alert tone="info" title="Why a hole matters">
        Rule 46(b) requires an invoice number to be <strong>consecutive</strong> and unique for the
        financial year; rule 53(1A)(c) says the same of a credit or debit note and rule 49 of a receipt
        voucher. At an assessment the question is never whether the numbers are unique — it is what
        happened to the one that is missing.
      </Alert>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Numbers issued" value={String(issued)} icon="Hash" foot={`Across ${reg.rows.length} series`} />
        <StatCard label="Unexplained gaps" value={String(reg.unexplained)} icon="AlertOctagon"
          tone={reg.unexplained > 0 ? 'accent' : 'default'}
          foot={reg.unexplained === 0 ? 'Every number is accounted for' : 'A number taken with no document behind it'} />
        <StatCard label="Patterns that breach rule 46" value={String(patternProblems.length)} icon="Ruler"
          foot={patternProblems.length === 0 ? 'All within sixteen characters' : 'Nothing further can be issued'} />
      </div>

      {reg.rows.length === 0 && (
        <Card><Empty icon="Hash" title="No series for this financial year"
          hint="A document series is created per financial year. Without one, nothing can be numbered and nothing can be issued." /></Card>
      )}

      {reg.rows.map((r) => (
        <Card key={r.docType} flush className="overflow-hidden">
          <CardHeader
            title={seriesLabel(r.docType)} className="p-5 pb-3"
            sub={`${r.pattern} · next ${r.nextNumber}`}
            action={
              <Pill tone={r.gaps.some((g) => g.reason === 'UNEXPLAINED') || r.patternProblem ? 'critical' : 'good'} dot>
                {r.issued === 0 ? 'none issued' : `${r.issued} issued`}
              </Pill>
            } />

          <div className="space-y-2 px-5 pb-4 text-[12.5px]">
            {r.patternProblem && (
              <div className="rounded-lg px-3 py-2" style={{ background: 'var(--critical-soft)' }}>
                <p className="font-semibold" style={{ color: 'var(--critical)' }}>This pattern breaches rule 46(b)</p>
                <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--critical)', opacity: 0.9 }}>
                  {r.patternProblem}. Nothing further can be issued under it — shorten the prefix.
                </p>
              </div>
            )}

            {r.issued > 0 && (
              <p style={{ color: 'var(--text-muted)' }}>
                Issued {r.firstSeq} to {r.lastSeq}
                {r.cancelled.length > 0 && `, of which ${r.cancelled.length} cancelled`}.
              </p>
            )}

            {r.gaps.map((g) => (
              <div key={`${g.reason}:${g.seq}`} className="rounded-lg px-3 py-2"
                style={{ background: g.reason === 'UNEXPLAINED' ? 'var(--critical-soft)' : 'var(--surface)' }}>
                <p className="font-semibold tabular"
                  style={{ color: g.reason === 'UNEXPLAINED' ? 'var(--critical)' : 'var(--text-secondary)' }}>
                  {g.number}
                </p>
                <p className="mt-0.5 leading-relaxed"
                  style={{ color: g.reason === 'UNEXPLAINED' ? 'var(--critical)' : 'var(--text-muted)' }}>
                  {g.detail}
                </p>
              </div>
            ))}

            {r.cancelled.length > 0 && (
              <ul className="space-y-1 pt-1">
                {r.cancelled.map((c) => (
                  <li key={c.number} style={{ color: 'var(--text-muted)' }}>
                    <span className="tabular">{c.number}</span> — cancelled
                    {c.reason ? `: ${c.reason}` : ', no reason recorded'}
                    {/* 🔴 it keeps its number on purpose: a cancelled invoice that released its
                        number would leave the hole this page exists to find */}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
