import { Card, CardHeader, Pill } from '@/components/ui/kit'
import { formatINR } from '@/lib/money'
import { ReverseButton } from '@/components/corrections/reverse-button'
import { unmatchBankAction } from '../actions'

export interface MatchedRow {
  id: string
  date: string
  narration: string
  amount: string
  direction: 'DEBIT' | 'CREDIT'
  matchedTo: string
  reason: string | null
  excluded: boolean
}

/**
 * The lines already matched — docs/49.
 *
 * 🔴 They were counted and never shown. The screen said "47 of 60 done" and listed only what
 * was left, so a line matched to the wrong invoice was invisible from the moment it was
 * matched: the number went up and the mistake went quiet. You cannot unmatch what you cannot
 * find, which is why the service built in docs/40 had nowhere to be called from.
 */
export function MatchedLines({ rows, total }: { rows: MatchedRow[]; total: number }) {
  if (rows.length === 0) return null

  return (
    <Card flush className="overflow-hidden">
      <CardHeader
        title="Matched" className="p-5 pb-3"
        sub={rows.length < total
          ? `the ${rows.length} most recent of ${total} — unmatching reverses what the match posted`
          : 'unmatching reverses what the match posted, and puts the line back in the queue'} />
      <table className="w-full text-[12.5px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
              <td className="px-5 py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>{r.date}</td>
              <td className="py-2.5">
                <span className="block">{r.narration}</span>
                <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {r.matchedTo}{r.reason ? ` · ${r.reason}` : ''}
                </span>
              </td>
              <td className="py-2.5 text-center">
                {r.excluded && <Pill tone="neutral">excluded</Pill>}
              </td>
              <td className="py-2.5 text-right font-semibold tabular">
                {r.direction === 'DEBIT' ? '−' : ''}{formatINR(r.amount)}
              </td>
              <td className="px-5 py-2.5 text-right">
                <ReverseButton action={unmatchBankAction} idName="txnId" id={r.id}
                  label="unmatch" confirmLabel="Unmatch" busyLabel="Unmatching…"
                  prompt="Why is this line being unmatched?" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
