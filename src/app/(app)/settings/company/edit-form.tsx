'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { saveCompanyAction } from './actions'

export interface CompanyEditable {
  tradeName: string
  tan: string
  email: string
  phone: string
  website: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  pincode: string
  country: string
}

/**
 * The half of the company record that can safely be edited — docs/67.
 *
 * 🔴 The other half — PAN, GSTIN, CIN, legal name and state code — is not here, because it is
 * quoted in filed returns, in the invoice series and in the tax mode of every future invoice.
 * The screen shows those beside this form and says why, rather than hiding them and leaving
 * somebody hunting for a field that was deliberately withheld.
 */
export function CompanyEditForm({ initial }: { initial: CompanyEditable }) {
  const [state, action, pending] = useActionState(saveCompanyAction, null)
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Button variant="ghost" size="sm" icon="Pencil" onClick={() => setOpen(true)}>
        Correct these details
      </Button>
    )
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Trade name" hint="if it differs from the legal name">
          <input name="tradeName" defaultValue={initial.tradeName} className={inputClass} style={inputStyle} />
        </Field>
        {/* handover §2 — the TAN was partly clipped in the source PDF and has never been
            verified against the TRACES record. It is the one field here worth checking. */}
        <Field label="TAN" hint="four letters, five digits, one letter — ⚠ verify, clipped in the source document">
          <input name="tan" defaultValue={initial.tan} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Email"><input name="email" defaultValue={initial.email} className={inputClass} style={inputStyle} /></Field>
        <Field label="Phone"><input name="phone" defaultValue={initial.phone} className={inputClass} style={inputStyle} /></Field>
      </div>
      <Field label="Website"><input name="website" defaultValue={initial.website} className={inputClass} style={inputStyle} /></Field>

      <p className="pt-1 eyebrow">Registered address</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Line 1" hint="rule 46(c) — it prints on every invoice">
          <input name="addressLine1" required defaultValue={initial.addressLine1} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Line 2"><input name="addressLine2" defaultValue={initial.addressLine2} className={inputClass} style={inputStyle} /></Field>
        <Field label="City"><input name="city" defaultValue={initial.city} className={inputClass} style={inputStyle} /></Field>
        <Field label="State"><input name="state" defaultValue={initial.state} className={inputClass} style={inputStyle} /></Field>
        <Field label="Pincode" hint="six digits">
          <input name="pincode" defaultValue={initial.pincode} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Country"><input name="country" defaultValue={initial.country} className={inputClass} style={inputStyle} /></Field>
      </div>

      {state?.error && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>{state.ok}</p>
      )}

      <div className="flex items-center gap-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
        <button type="button" onClick={() => setOpen(false)}
          className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>cancel</button>
      </div>
    </form>
  )
}
