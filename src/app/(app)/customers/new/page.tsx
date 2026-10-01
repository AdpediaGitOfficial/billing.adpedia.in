'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { createCustomerAction } from '../actions'
import { Card, PageHeader, Field, Button, inputClass, inputStyle, Pill } from '@/components/ui/kit'

const STATES = [
  ['32', 'Kerala'], ['29', 'Karnataka'], ['33', 'Tamil Nadu'], ['27', 'Maharashtra'],
  ['07', 'Delhi'], ['36', 'Telangana'], ['24', 'Gujarat'], ['09', 'Uttar Pradesh'],
  ['19', 'West Bengal'], ['06', 'Haryana'], ['37', 'Andhra Pradesh'], ['30', 'Goa'],
]

export default function NewCustomerPage() {
  const [state, action, pending] = useActionState(createCustomerAction, null)
  const [country, setCountry] = useState('IN')
  const [stateCode, setStateCode] = useState('32')

  // the same rule the server applies — shown so nobody has to guess
  const mode = country !== 'IN' ? 'Export · zero-rated, no GST'
    : stateCode === '32' ? 'Intra-state · CGST 9% + SGST 9%'
    : 'Inter-state · IGST 18%'

  return (
    <div className="max-w-2xl">
      <PageHeader title="New customer" sub="Tax treatment is derived from the country and state — you never pick it." />

      <form action={action}>
        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Registered name">
                <input name="name" required className={inputClass} style={inputStyle} placeholder="CLICK AR BUSINESS PRIVATE LIMITED" />
              </Field>
            </div>

            <Field label="Country">
              <select name="country" value={country} onChange={(e) => setCountry(e.target.value)} className={inputClass} style={inputStyle}>
                <option value="IN">India</option>
                <option value="AE">United Arab Emirates</option>
                <option value="US">United States</option>
                <option value="GB">United Kingdom</option>
                <option value="SG">Singapore</option>
              </select>
            </Field>

            {country === 'IN' && (
              <Field label="State">
                <select name="stateCode" value={stateCode} onChange={(e) => setStateCode(e.target.value)} className={inputClass} style={inputStyle}>
                  {STATES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                </select>
              </Field>
            )}

            {country === 'IN' && (
              <>
                <Field label="GSTIN" hint="Checked against the state — a mismatch is refused">
                  <input name="gstin" className={inputClass} style={inputStyle} placeholder="32AAKCC9890P1ZS" />
                </Field>
                <Field label="PAN">
                  <input name="pan" className={inputClass} style={inputStyle} />
                </Field>
              </>
            )}

            <Field label="Contact person"><input name="contactPerson" className={inputClass} style={inputStyle} /></Field>
            <Field label="Email"><input name="email" type="email" className={inputClass} style={inputStyle} /></Field>
            <Field label="Phone"><input name="phone" inputMode="tel" className={inputClass} style={inputStyle} /></Field>
            <Field label="Payment terms (days)">
              <input name="paymentTermDays" type="number" inputMode="numeric" defaultValue={15} className={inputClass} style={inputStyle} />
            </Field>

            {country === 'IN' && (
              <div className="sm:col-span-2">
                <Field label="Deducts TDS from us" hint="Printed on the invoice as the expected deduction, and excluded from collectible ageing">
                  <select name="defaultTdsSection" className={inputClass} style={inputStyle}>
                    <option value="">No TDS</option>
                    <option value="194J">194J — professional / technical fees (10%)</option>
                    <option value="194C">194C — contract work (2%)</option>
                  </select>
                </Field>
              </div>
            )}

            <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><Field label="Address line 1"><input name="line1" className={inputClass} style={inputStyle} /></Field></div>
              <div className="sm:col-span-2"><Field label="Address line 2"><input name="line2" className={inputClass} style={inputStyle} /></Field></div>
              <Field label="City"><input name="city" className={inputClass} style={inputStyle} /></Field>
              <Field label="Pincode"><input name="pincode" inputMode="numeric" className={inputClass} style={inputStyle} /></Field>
            </div>
          </div>

          <div className="mt-5 rounded-md px-3 py-2.5" style={{ background: 'var(--color-brand-50)' }}>
            <Pill>{mode}</Pill>
            {country !== 'IN' && (
              <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--color-brand-700)' }}>
                Export invoices need a LUT covering the financial year, and carry no TDS.
              </p>
            )}
          </div>

          {state?.error && (
            <p className="mt-4 rounded-md px-3 py-2 text-[12.5px]" style={{ background: '#FFF1F0', color: '#B4231F' }}>
              {state.error}
            </p>
          )}

          <div className="mt-5 flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save customer'}</Button>
            <Link href="/customers"><Button variant="ghost" type="button">Cancel</Button></Link>
          </div>
        </Card>
      </form>
    </div>
  )
}
