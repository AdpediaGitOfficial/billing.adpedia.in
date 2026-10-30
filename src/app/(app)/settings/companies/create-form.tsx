'use client'
import { useActionState } from 'react'
import { Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { createCompanyAction } from './actions'

const CONSTITUTIONS = [
  ['PROPRIETORSHIP', 'Proprietorship'],
  ['PRIVATE_LIMITED', 'Private limited'],
  ['LLP', 'LLP'],
  ['PARTNERSHIP', 'Partnership'],
  ['PUBLIC_LIMITED', 'Public limited'],
] as const

export function CreateCompanyForm() {
  const [state, action, pending] = useActionState(createCompanyAction, null)

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" hint="Exactly as registered — it prints on every document">
          <input name="legalName" required className={inputClass} style={inputStyle} placeholder="AKASH — PROPRIETOR" />
        </Field>
        <Field label="Constitution" hint="Decides the equity section: share capital, or capital and drawings">
          <select name="constitution" defaultValue="PROPRIETORSHIP" className={inputClass} style={inputStyle}>
            {CONSTITUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="PAN" hint="Its 4th character must agree with the constitution — P for an individual, C for a company">
          <input name="pan" required maxLength={10} autoCapitalize="characters"
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="AAAPA1234A" />
        </Field>
        <Field label="GSTIN" hint="Leave empty if this entity is not registered — it then issues a bill of supply, not a tax invoice">
          <input name="gstin" maxLength={15} autoCapitalize="characters"
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="32AAAPA1234A1Z5" />
        </Field>
        <Field label="State code" hint="Two digits — 32 is Kerala. Decides CGST+SGST versus IGST">
          <input name="stateCode" required maxLength={2} defaultValue="32" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Document prefix" hint="2 to 4 letters. Rule 46 caps a document number at 16 characters">
          <input name="seriesPrefix" required maxLength={4} autoCapitalize="characters"
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="SEC" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Registered address" hint="Rule 46(c) — it prints on every invoice">
          <input name="line1" required className={inputClass} style={inputStyle} placeholder="VIII/318, Chinnangath House" />
        </Field>
        <Field label="Address line 2" hint="Optional">
          <input name="line2" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="City"><input name="city" className={inputClass} style={inputStyle} placeholder="Thrissur" /></Field>
        <Field label="Pincode" hint="Six digits">
          <input name="pincode" maxLength={6} className={inputClass} style={inputStyle} placeholder="680683" />
        </Field>
        <Field label="Bank account label" hint="Optional — what GL 1010 is called here, e.g. “HDFC — Current 50200…”">
          <input name="bankLabel" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create the company'}</Button>
        {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
      </div>
      {state?.ok && <Alert tone="good" title="Created">{state.ok}</Alert>}
    </form>
  )
}
