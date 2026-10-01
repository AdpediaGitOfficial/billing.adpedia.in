import { Card, CardHeader, Pill } from '@/components/ui/kit'
import { formatINR } from '@/lib/money'
import type { ElectronicLedger } from '@/server/services/tax/gst-electronic-ledgers'

export interface LedgerView {
  title: string
  kind: 'CASH' | 'CREDIT'
  heads: { key: string; label: string; opening: string; credited: string; debited: string; closing: string }[]
  total: { opening: string; credited: string; debited: string; closing: string }
  notes: string[]
}

export function toLedgerView(l: ElectronicLedger): LedgerView {
  return {
    title: l.title, kind: l.kind,
    heads: l.heads.map((h) => ({
      key: h.key, label: h.label,
      opening: h.opening.toFixed(2), credited: h.credited.toFixed(2),
      debited: h.debited.toFixed(2), closing: h.closing.toFixed(2),
    })),
    total: {
      opening: l.total.opening.toFixed(2), credited: l.total.credited.toFixed(2),
      debited: l.total.debited.toFixed(2), closing: l.total.closing.toFixed(2),
    },
    notes: l.notes,
  }
}

/**
 * The two ledgers the portal keeps, side by side.
 *
 * 🔴 Head-wise on purpose. A single total would be the one number a filer must not act on:
 * CGST credit cannot pay SGST, and cash under one major head cannot pay another.
 */
export function ElectronicLedgers({ cash, credit, fyLabel }: { cash: LedgerView; credit: LedgerView; fyLabel: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[cash, credit].map((l) => (
        <Card key={l.kind} flush className="overflow-hidden">
          <CardHeader
            title={l.title}
            className="p-5 pb-3"
            sub={l.kind === 'CASH'
              ? `Funded by challan, debited by a set-off · FY ${fyLabel}`
              : `Accrues as bills post, consumed head-wise · FY ${fyLabel}`}
            action={
              <Pill tone={Number(l.total.closing) > 0 ? 'accent' : 'neutral'}>
                {formatINR(l.total.closing)} available
              </Pill>
            }
          />
          <div className="px-5 pb-4">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                  <th className="pb-1.5 font-medium">Head</th>
                  <th className="pb-1.5 text-right font-medium">Opening</th>
                  <th className="pb-1.5 text-right font-medium">In</th>
                  <th className="pb-1.5 text-right font-medium">Used</th>
                  <th className="pb-1.5 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {l.heads.map((h) => (
                  <tr key={h.key} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                    <td className="py-2">{h.label}</td>
                    <td className="py-2 text-right tabular" style={{ color: 'var(--text-muted)' }}>{formatINR(h.opening)}</td>
                    <td className="py-2 text-right tabular">{formatINR(h.credited)}</td>
                    <td className="py-2 text-right tabular" style={{ color: 'var(--text-muted)' }}>{formatINR(h.debited)}</td>
                    <td className="py-2 text-right font-semibold tabular">{formatINR(h.closing)}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold" style={{ borderColor: 'var(--text-primary)' }}>
                  <td className="py-2">Total</td>
                  <td className="py-2 text-right tabular">{formatINR(l.total.opening)}</td>
                  <td className="py-2 text-right tabular">{formatINR(l.total.credited)}</td>
                  <td className="py-2 text-right tabular">{formatINR(l.total.debited)}</td>
                  <td className="py-2 text-right tabular">{formatINR(l.total.closing)}</td>
                </tr>
              </tbody>
            </table>

            <ul className="mt-3 space-y-1.5">
              {l.notes.map((n) => (
                <li key={n} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>· {n}</li>
              ))}
            </ul>
          </div>
        </Card>
      ))}
    </div>
  )
}
