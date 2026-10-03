import { Card, CardHeader, Pill, Alert, type Tone } from '@/components/ui/kit'
import { formatINR } from '@/lib/money'
import type { LedgerReconciliation, ChallanReconciliation, Severity } from '@/server/services/tax/portal-reconciliation'

const TONE: Record<Severity, Tone> = { AGREED: 'good', INVESTIGATE: 'warn', SERIOUS: 'critical' }
const WORD: Record<Severity, string> = { AGREED: 'agrees', INVESTIGATE: 'look at this', SERIOUS: 'serious' }

/**
 * One ledger, three columns: what we say, what the portal should therefore be holding, and
 * what it says it holds.
 *
 * 🔴 The middle column is the whole point. Our credit-ledger balance and the portal's are
 * not the same quantity — ours is credit the books have accrued, the portal's is credit a
 * filed GSTR-3B has claimed. Printing two columns and a difference would report a hole
 * every month of the year that means nothing at all.
 */
export function LedgerComparison({ r }: { r: LedgerReconciliation }) {
  const worst: Severity = r.heads.some((h) => h.severity === 'SERIOUS') ? 'SERIOUS'
    : r.heads.some((h) => h.severity === 'INVESTIGATE') ? 'INVESTIGATE' : 'AGREED'

  return (
    <Card flush className="overflow-hidden">
      {/* 🔴 the verdict goes in the subtitle, not the pill. A pill carrying a whole sentence
          squeezes the title to one word a column wide on a phone. */}
      <CardHeader
        title={r.title} className="p-5 pb-3"
        sub={r.asOn
          ? `Against the portal as at ${r.asOn.toISOString().slice(0, 10)} · ${r.verdict}`
          : 'Nothing imported yet — these are our own figures only'}
        action={<Pill tone={r.asOn ? TONE[worst] : 'neutral'} dot>{r.asOn ? WORD[worst] : 'not checked'}</Pill>} />

      {r.approximate && (
        <div className="px-5 pb-3">
          <Alert tone="info" title="Head-wise is approximate here">{r.approximate}</Alert>
        </div>
      )}

      {/* phone: one block per head, because five columns of money on a 375px screen
          collapse into each other and the figures stop being readable at all */}
      <div className="space-y-3 px-5 pb-4 sm:hidden">
        {r.heads.map((h) => (
          <div key={h.head} className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
            <p className="flex items-center gap-2 text-[13px] font-semibold">
              {h.label}
              {r.asOn && h.severity !== 'AGREED' && <Pill tone={TONE[h.severity]}>{WORD[h.severity]}</Pill>}
            </p>
            <dl className="mt-1.5 space-y-0.5 text-[12.5px]">
              {([
                ['Our books', formatINR(h.ours)],
                ['Should be on the portal', formatINR(h.expected)],
                ['Portal says', h.portal === null ? '—' : formatINR(h.portal)],
                ['Difference', h.portal === null ? '—' : formatINR(h.difference)],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
                  <dd className="tabular">{v}</dd>
                </div>
              ))}
            </dl>
            {h.meaning && (
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{h.meaning}</p>
            )}
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t pt-2 text-[12.5px] font-semibold" style={{ borderColor: 'var(--rule)' }}>
          <span>Total difference</span><span className="tabular">{formatINR(r.total.difference)}</span>
        </div>
      </div>

      <div className="hidden px-5 pb-4 sm:block">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
              <th className="pb-1.5 font-medium">Head</th>
              <th className="pb-1.5 text-right font-medium">Our books</th>
              <th className="pb-1.5 text-right font-medium">Should be on the portal</th>
              <th className="pb-1.5 text-right font-medium">Portal says</th>
              <th className="pb-1.5 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody>
            {r.heads.map((h) => (
              <tr key={h.head} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-2">
                  {h.label}
                  {r.asOn && h.severity !== 'AGREED' && (
                    <span className="ml-2 align-middle"><Pill tone={TONE[h.severity]}>{WORD[h.severity]}</Pill></span>
                  )}
                  {h.meaning && (
                    <span className="mt-1 block max-w-prose text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {h.meaning}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right tabular">{formatINR(h.ours)}</td>
                <td className="py-2 text-right tabular" style={{ color: 'var(--text-muted)' }}>{formatINR(h.expected)}</td>
                <td className="py-2 text-right tabular">{h.portal === null ? '—' : formatINR(h.portal)}</td>
                <td className="py-2 text-right font-semibold tabular"
                  style={{ color: h.severity === 'SERIOUS' ? 'var(--critical)' : h.severity === 'INVESTIGATE' ? 'var(--warn)' : undefined }}>
                  {h.portal === null ? '—' : formatINR(h.difference)}
                </td>
              </tr>
            ))}
            <tr className="border-t font-semibold" style={{ borderColor: 'var(--text-primary)' }}>
              <td className="py-2">Total</td>
              <td className="py-2 text-right tabular">{formatINR(r.total.ours)}</td>
              <td className="py-2 text-right tabular">{formatINR(r.total.expected)}</td>
              <td className="py-2 text-right tabular">{formatINR(r.total.portal)}</td>
              <td className="py-2 text-right tabular">{formatINR(r.total.difference)}</td>
            </tr>
          </tbody>
        </table>

      </div>

      <ul className="space-y-1.5 px-5 pb-4">
        {r.notes.map((n) => (
          <li key={n} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>· {n}</li>
        ))}
      </ul>
    </Card>
  )
}

export function ChallanComparison({ r, title }: { r: ChallanReconciliation; title: string }) {
  const problems = r.mismatched.length + r.notOnPortal.length + r.notInBooks.length
  return (
    <Card flush className="overflow-hidden">
      <CardHeader
        title={title} className="p-5 pb-3"
        sub={r.asOn
          ? `Against the portal as at ${r.asOn.toISOString().slice(0, 10)} · ${r.verdict}`
          : 'Nothing imported yet — every challan below is recorded on our word alone'}
        action={
          <Pill tone={!r.asOn ? 'neutral' : problems === 0 ? 'good' : 'critical'} dot>
            {!r.asOn ? 'not checked' : problems === 0 ? 'all confirmed' : `${problems} to look at`}
          </Pill>
        } />

      <div className="space-y-2 px-5 pb-4 text-[12.5px]">
        {r.mismatched.map((m) => (
          <div key={m.challanId} className="rounded-lg px-3 py-2" style={{ background: 'var(--critical-soft)' }}>
            <p className="font-semibold tabular" style={{ color: 'var(--critical)' }}>{m.reference}</p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--critical)', opacity: 0.9 }}>{m.problem}</p>
          </div>
        ))}
        {r.notOnPortal.map((m) => (
          <div key={m.challanId} className="rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)' }}>
            <p className="font-semibold tabular" style={{ color: 'var(--warn)' }}>
              {m.reference} · {formatINR(m.amount)} · {m.depositedOn.toISOString().slice(0, 10)}
            </p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--warn)', opacity: 0.9 }}>{m.action}</p>
          </div>
        ))}
        {r.unchecked.map((m) => (
          <div key={m.challanId} className="flex flex-wrap items-baseline gap-x-2 border-t py-2" style={{ borderColor: 'var(--rule)' }}>
            <span className="font-medium tabular">{m.reference}</span>
            <span className="tabular" style={{ color: 'var(--text-muted)' }}>
              {m.depositedOn.toISOString().slice(0, 10)} · {formatINR(m.amount)}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{m.why}</span>
            <Pill tone="neutral">not checked</Pill>
          </div>
        ))}

        {r.notInBooks.map((m, i) => (
          <div key={i} className="rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)' }}>
            <p className="font-semibold tabular" style={{ color: 'var(--warn)' }}>{m.cin ?? 'on the portal'}</p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--warn)', opacity: 0.9 }}>{m.action}</p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{m.raw}</p>
          </div>
        ))}

        {r.confirmed.length > 0 && (
          <table className="w-full">
            <tbody>
              {r.confirmed.map((m) => (
                <tr key={m.challanId} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 font-medium tabular">
                    {m.reference}
                    {m.corrected && (
                      <span className="mt-0.5 block max-w-prose text-[11.5px] font-normal leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        {m.corrected}
                      </span>
                    )}
                  </td>
                  <td className="py-2" style={{ color: 'var(--text-muted)' }}>{m.depositedOn.toISOString().slice(0, 10)}</td>
                  <td className="py-2 text-right tabular">{formatINR(m.amount)}</td>
                  <td className="py-2 pl-3 text-right"><Pill tone="good" dot>matched on {m.tier}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {problems === 0 && r.confirmed.length === 0 && r.unchecked.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>No challans to compare.</p>
        )}
      </div>
    </Card>
  )
}
