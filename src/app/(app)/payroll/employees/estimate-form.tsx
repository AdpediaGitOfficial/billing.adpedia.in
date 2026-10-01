'use client'
import { useActionState, useState } from 'react'
import { setEstimateAction } from '../actions'
import { CardHeader, Field, Button, inputClass, inputStyle } from '@/components/ui/kit'

export function EstimateForm({ employees, fyLabel }: { employees: { id: string; name: string; current: string }[]; fyLabel: string }) {
  const [state, action, pending] = useActionState(setEstimateAction, null)
  const [employeeId, setEmployeeId] = useState('')
  const current = employees.find((e) => e.id === employeeId)?.current

  return (
    <form action={action}>
      <CardHeader title={`Annual tax estimate — FY ${fyLabel}`}
        sub="Supplied by the CA. Regime, declarations and other income are theirs to judge; this records the number and prorates it." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Employee">
          <select name="employeeId" required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputClass} style={inputStyle}>
            <option value="">Select…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Estimated annual tax" hint={current ? `Currently ₹${Number(current).toLocaleString('en-IN')}` : undefined}>
          <input name="estimatedAnnualTax" required inputMode="decimal" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Source" hint="For the audit trail">
          <input name="source" className={inputClass} style={inputStyle} placeholder="CA estimate, Oct 2026" />
        </Field>
      </div>

      {state?.error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>}
      {state?.ok && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>
        Saved. A revision supersedes the previous figure rather than overwriting it, and the next run reprorates over the months remaining.
      </p>}

      <div className="mt-4"><Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save estimate'}</Button></div>
    </form>
  )
}
