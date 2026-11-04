'use client'
import { useActionState, useState } from 'react'
import { Card, CardHeader, Button, Field, Alert, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { recordSetOffAction, cancelSetOffAction } from './filing-actions'
import { ReverseButton } from '@/components/corrections/reverse-button'

export interface SetOffView {
  periodLabel: string
  dueOn: string
  /** the date the plan was computed for — and the date the form posts */
  asAt: string
  rows: { head: string; liability: string; byCredit: string; inCash: string; short: string }[]
  interestRow: { due: string; inCash: string; short: string } | null
  creditUsed: string
  cashUsed: string
  shortTotal: string
  interestToDate: { days: number; interest: string }
  notes: string[]
  warnings: string[]
  history: { id: string; periodLabel: string; setOffOn: string; creditUsed: string; cashUsed: string; cancelled: boolean }[]
}

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * GSTR-3B table 6.1, as a thing you can act on.
 *
 * 🔴 The set-off is the event that discharges the tax. A challan only funds the cash ledger,
 * and under rule 88B(1) interest runs until that ledger is debited — so this screen exists to
 * make the second step visible rather than implied.
 */
export function SetOff({ view }: { view: SetOffView }) {
  const [state, action, pending] = useActionState(recordSetOffAction, null)
  const [open, setOpen] = useState(false)
  const nothingToDo = view.rows.every((r) => Number(r.liability) === 0) && !view.interestRow

  return (
    <Card flush className="overflow-hidden">
      <CardHeader
        title="Set off the liability"
        className="p-5 pb-3"
        sub={`Table 6.1 for ${view.periodLabel} · due ${view.dueOn} · as the ledgers stand on ${view.asAt}`}
        action={
          nothingToDo
            ? <Pill tone="good" dot>Nothing outstanding</Pill>
            : Number(view.shortTotal) > 0
              ? <Pill tone="warn" dot>{inr(view.shortTotal)} short</Pill>
              : <Pill tone="accent" dot>Ready</Pill>
        }
      />

      <div className="px-5 pb-5">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
              <th className="pb-1.5 font-medium">Head</th>
              <th className="pb-1.5 text-right font-medium">Liability</th>
              <th className="pb-1.5 text-right font-medium">Through credit</th>
              <th className="pb-1.5 text-right font-medium">In cash</th>
              <th className="pb-1.5 text-right font-medium">Still to deposit</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.head} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-2">{r.head}</td>
                <td className="py-2 text-right tabular">{inr(r.liability)}</td>
                <td className="py-2 text-right tabular">{inr(r.byCredit)}</td>
                <td className="py-2 text-right tabular">{inr(r.inCash)}</td>
                <td className="py-2 text-right tabular font-semibold"
                  style={{ color: Number(r.short) > 0 ? 'var(--warn)' : 'var(--text-muted)' }}>
                  {inr(r.short)}
                </td>
              </tr>
            ))}
            {view.interestRow && (
              <tr className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-2">Interest &amp; late fee</td>
                <td className="py-2 text-right tabular">{inr(view.interestRow.due)}</td>
                <td className="py-2 text-right tabular" style={{ color: 'var(--text-muted)' }}>—</td>
                <td className="py-2 text-right tabular">{inr(view.interestRow.inCash)}</td>
                <td className="py-2 text-right tabular font-semibold">{inr(view.interestRow.short)}</td>
              </tr>
            )}
            <tr className="border-t font-semibold" style={{ borderColor: 'var(--text-primary)' }}>
              <td className="py-2">Total</td>
              <td className="py-2 text-right tabular" />
              <td className="py-2 text-right tabular">{inr(view.creditUsed)}</td>
              <td className="py-2 text-right tabular">{inr(view.cashUsed)}</td>
              <td className="py-2 text-right tabular">{inr(view.shortTotal)}</td>
            </tr>
          </tbody>
        </table>

        {view.interestToDate.days > 0 && (
          <Alert tone="critical" title={`${view.interestToDate.days} days past the due date`}>
            Interest to today works out at <strong>{inr(view.interestToDate.interest)}</strong> on the cash
            component. Under rule 88B(1) it runs until the cash ledger is <strong>debited</strong> — funding the
            ledger earlier did not stop it.
          </Alert>
        )}

        {/* "nothing left to discharge" is an answer, not a warning — the pill already says it */}
        {!nothingToDo && view.warnings.map((w) => <Alert key={w} tone="warn" title="Before you set off">{w}</Alert>)}

        <ul className="mt-3 space-y-1.5">
          {view.notes.map((n) => (
            <li key={n} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>· {n}</li>
          ))}
        </ul>

        {/* 🔴 Not offered while the ledger is short. A set-off is all or nothing — the portal
            will not let a return be filed with part of the tax unpaid, and neither will the
            service — so a button that could only fail is worse than no button. */}
        {!nothingToDo && Number(view.shortTotal) > 0 && (
          <p className="mt-4 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Record a challan for the heads above first. A set-off discharges the whole liability or none of
            it, and cash under one major head cannot be used for another.
          </p>
        )}

        {!nothingToDo && Number(view.shortTotal) === 0 && (
          <div className="mt-4">
            {open ? (
              <form action={action} className="space-y-3">
                <input type="hidden" name="periodLabel" value={view.periodLabel} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Set off on" hint="The date the portal debited the ledgers">
                    <input type="date" name="setOffOn" required defaultValue={view.asAt}
                      className={inputClass} style={inputStyle} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={pending}>{pending ? 'Posting…' : 'Record set-off'}</Button>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Record the set-off</Button>
            )}
          </div>
        )}

        {state && (
          <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: state.error ? 'var(--critical)' : 'var(--good)' }}>
            {state.error ?? state.ok}
          </p>
        )}

        {view.history.length > 0 && (
          <table className="mt-4 w-full text-[12.5px]">
            <tbody>
              {view.history.map((h) => (
                <tr key={h.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 font-medium"
                    style={h.cancelled ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
                    {h.periodLabel}
                  </td>
                  <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>{h.setOffOn}</td>
                  <td className="py-2 text-right tabular">credit {inr(h.creditUsed)}</td>
                  <td className="py-2 text-right tabular font-semibold">cash {inr(h.cashUsed)}</td>
                  <td className="py-2 pl-3 text-right">
                    {h.cancelled
                      ? <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>cancelled</span>
                      : <ReverseButton action={cancelSetOffAction} idName="setOffId" id={h.id}
                          prompt={`Why is the ${h.periodLabel} set-off being reversed?`} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  )
}
