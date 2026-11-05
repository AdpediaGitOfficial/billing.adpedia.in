'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { updateCustomerAction } from '../actions'
import { Card, Field, Button, Alert, inputClass, inputStyle, Pill } from '@/components/ui/kit'
import { CountrySelect, StateSelect, CurrencySelect } from '@/components/ui/geo'

export interface CustomerValues {
  id: string; name: string; contactPerson: string; email: string; phone: string
  country: string; stateCode: string; gstin: string; pan: string; currency: string
  paymentTermDays: number; defaultTdsSection: string
  line1: string; line2: string; city: string; pincode: string
}

export function EditCustomerForm({ customer, issuedInvoices }: {
  customer: CustomerValues; issuedInvoices: number
}) {
  const [state, action, pending] = useActionState(updateCustomerAction, null)
  const [country, setCountry] = useState(customer.country)
  const [stateCode, setStateCode] = useState(customer.stateCode || '32')
  const [gstin, setGstin] = useState(customer.gstin)
  const [currency, setCurrency] = useState(customer.currency)

  const mode = country !== 'IN' ? 'Export · zero-rated, no GST'
    : stateCode === '32' ? 'Intra-state · CGST 9% + SGST 9%'
    : 'Inter-state · IGST 18%'

  // 🔴 A change to the state code or the GSTIN changes how FUTURE invoices are taxed.
  // Invoices already issued keep their own frozen copy, so nothing retrospective happens —
  // but someone should know the treatment is about to switch rather than discover it on the
  // next invoice.
  const taxChanged = stateCode !== customer.stateCode || country !== customer.country
    || gstin !== customer.gstin || currency !== customer.currency

  return (
    <form action={action}>
      <input type="hidden" name="id" value={customer.id} />
      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Registered name">
              <input name="name" required defaultValue={customer.name} className={inputClass} style={inputStyle} />
            </Field>
          </div>

          <Field label="Country">
            <CountrySelect name="country" value={country} onChange={(e) => setCountry(e.target.value)} />
          </Field>

          {country === 'IN' && (
            <Field label="State">
              <StateSelect name="stateCode" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
            </Field>
          )}

          {country === 'IN' && (
            <>
              <Field label="GSTIN" hint="Checked against the state — a mismatch is refused">
                <input name="gstin" value={gstin} onChange={(e) => setGstin(e.target.value)}
                  className={inputClass} style={inputStyle} />
              </Field>
              <Field label="PAN">
                <input name="pan" defaultValue={customer.pan} className={inputClass} style={inputStyle} />
              </Field>
            </>
          )}

          <Field label="Contact person"><input name="contactPerson" defaultValue={customer.contactPerson} className={inputClass} style={inputStyle} /></Field>
          <Field label="Email"><input name="email" type="email" defaultValue={customer.email} className={inputClass} style={inputStyle} /></Field>
          <Field label="Phone"><input name="phone" inputMode="tel" defaultValue={customer.phone} className={inputClass} style={inputStyle} /></Field>
          <Field label="Payment terms (days)">
            <input name="paymentTermDays" type="number" inputMode="numeric" defaultValue={customer.paymentTermDays} className={inputClass} style={inputStyle} />
          </Field>

          {country !== 'IN' && (
            <Field label="Bill this client in"
              hint="Agreed with the client, never inferred from their country. Invoices already issued keep the currency they were raised in.">
              <CurrencySelect name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </Field>
          )}

          {country === 'IN' && (
            <div className="sm:col-span-2">
              <Field label="Deducts TDS from us">
                <select name="defaultTdsSection" defaultValue={customer.defaultTdsSection} className={inputClass} style={inputStyle}>
                  <option value="">No TDS</option>
                  <option value="194J">194J — professional / technical fees (10%)</option>
                  <option value="194C">194C — contract work (2%)</option>
                </select>
              </Field>
            </div>
          )}

          <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Address line 1"><input name="line1" defaultValue={customer.line1} className={inputClass} style={inputStyle} /></Field></div>
            <div className="sm:col-span-2"><Field label="Address line 2"><input name="line2" defaultValue={customer.line2} className={inputClass} style={inputStyle} /></Field></div>
            <Field label="City"><input name="city" defaultValue={customer.city} className={inputClass} style={inputStyle} /></Field>
            <Field label="Pincode"><input name="pincode" inputMode="numeric" defaultValue={customer.pincode} className={inputClass} style={inputStyle} /></Field>
          </div>
        </div>

        <div className="mt-5 rounded-md px-3 py-2.5" style={{ background: 'var(--color-brand-50)' }}>
          <Pill>{mode}</Pill>
        </div>

        {issuedInvoices > 0 && (
          <div className="mt-4">
            <Alert tone={taxChanged ? 'warn' : 'info'}
              title={taxChanged
                ? `This changes the tax treatment of future invoices — ${issuedInvoices} already issued are unaffected`
                : `${issuedInvoices} invoices have been issued to this customer`}>
              Every issued invoice keeps the name, address and GSTIN it carried when it was
              sent, so nothing already with the client changes. {taxChanged && 'The new treatment applies from the next invoice onward.'}
            </Alert>
          </div>
        )}

        {state?.error && (
          <p className="mt-4 rounded-md px-3 py-2 text-[12.5px]" style={{ background: '#FFF1F0', color: '#B4231F' }}>
            {state.error}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</Button>
          <Link href="/customers"><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
