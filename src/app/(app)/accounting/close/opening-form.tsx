'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { setOpeningBalancesAction } from './actions'

type Row = { accountCode: string; debit: string; credit: string }
const blank = (): Row => ({ accountCode: '', debit: '', credit: '' })
const n = (v: string) => Number(v || '0') || 0
const inr = (v: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(v)

/**
 * 🔴 The difference is shown as it is typed, and named.
 *
 * An opening entry that does not balance is the normal state of a migration halfway through,
 * and the number that closes it is almost always retained earnings. Saying so while somebody
 * is still typing is worth more than refusing at the end.
 */
export function OpeningForm({ accounts, initial }: {
  accounts: { code: string; name: string; type: string }[]
  initial: Row[]
}) {
  const [state, action, pending] = useActionState(setOpeningBalancesAction, null)
  const [rows, setRows] = useState<Row[]>(initial.length ? initial : [blank(), blank()])

  const totalDebit = rows.reduce((a, r) => a + n(r.debit), 0)
  const totalCredit = rows.reduce((a, r) => a + n(r.credit), 0)
  const diff = totalDebit - totalCredit
  const empty = totalDebit === 0 && totalCredit === 0

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lines" value={JSON.stringify(rows.filter((r) => r.accountCode && (n(r.debit) || n(r.credit))))} />

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-12">
            <div className="sm:col-span-6">
              <input list="opening-accounts" value={r.accountCode} placeholder="Account code"
                onChange={(e) => set(i, { accountCode: e.target.value.split(' ')[0] })}
                className={inputClass} style={inputStyle} />
            </div>
            <div className="sm:col-span-2">
              <input value={r.debit} onChange={(e) => set(i, { debit: e.target.value, credit: '' })}
                placeholder="Debit" inputMode="decimal" className={inputClass} style={inputStyle} />
            </div>
            <div className="sm:col-span-2">
              <input value={r.credit} onChange={(e) => set(i, { credit: e.target.value, debit: '' })}
                placeholder="Credit" inputMode="decimal" className={inputClass} style={inputStyle} />
            </div>
            <div className="sm:col-span-2 flex items-center">
              {rows.length > 1 && (
                <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  className="w-full rounded-md py-2 text-[12px]" style={{ color: 'var(--critical)' }}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </div>
      <datalist id="opening-accounts">
        {accounts.map((a) => <option key={a.code} value={`${a.code} ${a.name}`} />)}
      </datalist>

      <button type="button" onClick={() => setRows((rs) => [...rs, blank()])}
        className="text-[13px] font-semibold" style={{ color: 'var(--accent)' }}>+ Add line</button>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-[12.5px]"
           style={{ borderColor: 'var(--rule)' }}>
        <span className="tabular" style={{ color: 'var(--text-muted)' }}>
          Debits {inr(totalDebit)} · Credits {inr(totalCredit)}
        </span>
        {/**
          * 🔴 An empty entry is not a balanced one.
          *
          * Zero against zero satisfies `diff === 0`, and the first version said "Balanced" in
          * green over a blank form with the button live — docs/71's "shortfall ₹0.00" in a new
          * place: a zero that reads as a verdict. Nothing entered is its own state.
          */}
        <span className="tabular font-semibold"
          style={{ color: empty ? 'var(--text-muted)' : diff === 0 ? 'var(--good)' : 'var(--critical)' }}>
          {empty ? 'Nothing entered yet'
            : diff === 0 ? 'Balanced'
            : `Out by ${inr(Math.abs(diff))} — usually retained earnings (3100)`}
        </span>
      </div>

      <Field label="Where these came from" hint="Read later by whoever asks why the first year starts here">
        <input name="note" className={inputClass} style={inputStyle} placeholder="From the Tally export, 31 Mar 2026" />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending || empty || diff !== 0}>{pending ? 'Posting…' : 'Post the opening entry'}</Button>
        {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
        {state?.ok && <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>}
      </div>
    </form>
  )
}
