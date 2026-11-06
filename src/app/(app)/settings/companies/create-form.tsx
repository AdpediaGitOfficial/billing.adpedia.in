'use client'
import { useActionState } from 'react'
import { CONSTITUTION_LABEL, CONSTITUTION_ORDER } from '@/lib/constitution'
import { Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { StateSelect, CurrencySelect } from '@/components/ui/geo'
import { createCompanyAction } from './actions'

export function CreateCompanyForm() {
  const [state, action, pending] = useActionState(createCompanyAction, null)

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" hint="Exactly as registered — it prints on every document">
          <input name="legalName" required className={inputClass} style={inputStyle} placeholder="AKASH — PROPRIETOR" />
        </Field>
        <Field label="Constitution" hint="Personal account — your own freelance income, no GST and no company filings. The others carry the full legal compliance.">
          <select name="constitution" defaultValue="PROPRIETORSHIP" className={inputClass} style={inputStyle}>
            {CONSTITUTION_ORDER.map((v) => <option key={v} value={v}>{CONSTITUTION_LABEL[v]}</option>)}
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
        <Field label="State" hint="Decides CGST+SGST versus IGST — and must agree with the GSTIN above">
          <StateSelect name="stateCode" required defaultValue="32" />
        </Field>
        <Field label="Document prefix" hint="2 to 4 letters. Rule 46 caps a document number at 16 characters">
          <input name="seriesPrefix" required maxLength={4} autoCapitalize="characters"
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="SEC" />
        </Field>
        <Field label="Bills overseas clients in"
          hint="The default for a new export client — each client can be set to something else. The books stay in rupees.">
          <CurrencySelect name="billingCurrencyDefault" defaultValue="USD" />
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
        <Field label="Signatory" hint="Who signs this entity's documents — printed above the rule">
          <input name="signatoryName" className={inputClass} style={inputStyle} placeholder="Shinelal C P" />
        </Field>
        <Field label="Designation" hint="A company has a director; a firm has a managing partner">
          <input name="signatoryDesignation" className={inputClass} style={inputStyle} placeholder="Managing Partner" />
        </Field>
        <Field label="Email" hint="Printed in the document footer — how a client reaches this entity">
          <input name="email" type="email" className={inputClass} style={inputStyle} placeholder="name@example.com" />
        </Field>
        <Field label="Phone" hint="Optional — also printed in the footer">
          <input name="phone" inputMode="tel" className={inputClass} style={inputStyle} placeholder="9447768570" />
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
