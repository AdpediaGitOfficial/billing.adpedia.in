'use client'
import { useActionState, useState } from 'react'
import { recordMovementAction } from './actions'
import { Field, Button, Segmented, inputClass, inputStyle } from '@/components/ui/kit'

interface Purpose { value: string; label: string; note: string }

const today = () => new Date().toISOString().slice(0, 10)

export function MovementForm({ purposes, drawingsLabel }: { purposes: Purpose[]; drawingsLabel: string }) {
  const [state, action, pending] = useActionState(recordMovementAction, null)
  const [kind, setKind] = useState('DRAWING')
  const [purpose, setPurpose] = useState(purposes[0].value)
  const chosen = purposes.find((p) => p.value === purpose) ?? purposes[0]

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="kind" value={kind} />
      <Segmented value={kind} onChange={setKind} options={[
        { value: 'DRAWING', label: `${drawingsLabel} — money out` },
        { value: 'CAPITAL', label: 'Capital — money in' },
      ]} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Date">
          <input type="date" name="date" required defaultValue={today()} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Amount" hint="₹">
          <input name="amount" required inputMode="decimal" placeholder="85000" className={inputClass + ' tabular'} style={inputStyle} />
        </Field>
        <Field label="Out of">
          <select name="source" className={inputClass} style={inputStyle}>
            <option value="BANK">Bank</option>
            <option value="CASH">Cash in hand</option>
          </select>
        </Field>
      </div>

      {/* 🔴 only on a drawing: capital coming in has no purpose to record */}
      {kind === 'DRAWING' && (
        <Field label="What it was for" hint={chosen.note}>
          <select name="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}
            className={inputClass} style={inputStyle}>
            {purposes.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
      )}

      <Field label="Note" hint="what a stranger reading the bank statement in March would need">
        <input name="narration" required minLength={3}
          placeholder={kind === 'DRAWING' ? 'October rent, Chalakudy' : 'Transfer from savings to fund the account'}
          className={inputClass} style={inputStyle} />
      </Field>

      {state?.error && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>
          {state.ok}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? 'Recording…' : kind === 'DRAWING' ? 'Record the drawing' : 'Record the capital'}
      </Button>
    </form>
  )
}
