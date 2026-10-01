'use client'
import { useActionState, useState } from 'react'
import { createChallanAction } from './actions'
import { Field, Button, Pill, inputClass, inputStyle } from '@/components/ui/kit'

export function ChallanForm({ sections }: { sections: { code: string; amount: string; ids: string[]; quarter: number }[] }) {
  const [state, action, pending] = useActionState(createChallanAction, null)
  const [code, setCode] = useState(sections[0]?.code ?? '')
  const selected = sections.find((s) => s.code === code)

  return (
    <form action={action}>
      <input type="hidden" name="deductionIds" value={JSON.stringify(selected?.ids ?? [])} />
      <input type="hidden" name="quarter" value={selected?.quarter ?? 1} />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Section">
          <select name="sectionCode" value={code} onChange={(e) => setCode(e.target.value)} className={inputClass} style={inputStyle}>
            {sections.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}
          </select>
        </Field>
        <Field label="BSR code" hint="7 digits">
          <input name="bsrCode" required inputMode="numeric" maxLength={7} className={inputClass} style={inputStyle} placeholder="0510308" />
        </Field>
        <Field label="Challan serial" hint="up to 5 digits">
          <input name="challanSerial" required inputMode="numeric" maxLength={5} className={inputClass} style={inputStyle} placeholder="00001" />
        </Field>
        <Field label="Deposited on">
          <input name="depositedOn" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Interest" hint="s.201(1A)">
          <input name="interest" inputMode="decimal" defaultValue="0" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Late fee" hint="s.234E">
          <input name="lateFee" inputMode="decimal" defaultValue="0" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      {selected && (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          This challan will cover <Pill tone="accent">{selected.ids.length} deduction{selected.ids.length === 1 ? '' : 's'}</Pill>{' '}
          totalling <strong>₹{Number(selected.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong> under section {selected.code}.
        </p>
      )}

      {state?.error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>}
      {state?.ok && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>Challan recorded and the deductions linked.</p>}

      <div className="mt-4"><Button type="submit" disabled={pending || !selected}>{pending ? 'Recording…' : 'Record challan'}</Button></div>
    </form>
  )
}
