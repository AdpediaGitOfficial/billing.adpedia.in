'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'

import { Card, PageHeader, Field, Button, Alert, inputClass, inputStyle } from '@/components/ui/kit'

const STATES = [['32', 'Kerala'], ['29', 'Karnataka'], ['33', 'Tamil Nadu'], ['27', 'Maharashtra'], ['07', 'Delhi'], ['36', 'Telangana'], ['24', 'Gujarat']]

export interface VendorInitial {
  id?: string
  name: string
  vendorType: string
  country: string
  stateCode: string | null
  gstin: string | null
  pan: string | null
  defaultTdsSection: string | null
  email: string | null
  paymentTermDays: number
}

type Result = { error?: string } | null

/**
 * One form, two jobs — docs/49.
 *
 * The new-vendor screen derived reverse charge and the TDS consequences live while you typed,
 * and `updateVendor` had existed since docs/41 with no page to call it. Copying this form to
 * make an edit screen would have meant two places for those warnings to drift apart, on a
 * screen whose entire value is that it tells you what a field is about to do.
 */
export function VendorForm({ action: submit, initial, title, sub, submitLabel }: {
  action: (prev: Result, form: FormData) => Promise<Result>
  initial?: VendorInitial
  title: string
  sub: string
  submitLabel: string
}) {
  const [state, action, pending] = useActionState(submit, null)
  const [country, setCountry] = useState(initial?.country ?? 'IN')
  const [gstin, setGstin] = useState(initial?.gstin ?? '')
  const [pan, setPan] = useState(initial?.pan ?? '')

  const foreign = country !== 'IN'
  const rcm = foreign && !gstin
  const panOk = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.toUpperCase())

  return (
    <div className="max-w-2xl">
      <PageHeader title={title} sub={sub} />

      <form action={action}>
        {initial?.id && <input type="hidden" name="id" value={initial.id} />}
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Name"><input name="name" required defaultValue={initial?.name} className={inputClass} style={inputStyle} placeholder="Exalture Software Lab" /></Field>
            </div>

            <Field label="Type">
              <select name="vendorType" className={inputClass} style={inputStyle} defaultValue={initial?.vendorType ?? 'FREELANCER'}>
                <option value="FREELANCER">Freelancer</option>
                <option value="SUBCONTRACTOR">Subcontractor</option>
                <option value="AGENCY">Agency</option>
                <option value="CLOUD">Cloud / hosting</option>
                <option value="UTILITY">Utility</option>
                <option value="PROFESSIONAL">Professional (CA, legal)</option>
                <option value="SUPPLIER">Supplier</option>
                <option value="OTHER">Other</option>
              </select>
            </Field>

            <Field label="Country">
              <select name="country" value={country} onChange={(e) => setCountry(e.target.value)} className={inputClass} style={inputStyle}>
                <option value="IN">India</option>
                <option value="US">United States</option>
                <option value="SG">Singapore</option>
                <option value="AE">United Arab Emirates</option>
                <option value="GB">United Kingdom</option>
                <option value="IE">Ireland</option>
              </select>
            </Field>

            {!foreign && (
              <>
                <Field label="State">
                  <select name="stateCode" className={inputClass} style={inputStyle} defaultValue={initial?.stateCode ?? '32'}>
                    {STATES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
                  </select>
                </Field>
                <Field label="GSTIN" hint="Leave blank if the vendor is unregistered">
                  <input name="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className={inputClass} style={inputStyle} />
                </Field>
              </>
            )}
            {foreign && (
              <div className="sm:col-span-2">
                <Field label="Indian GSTIN, if the vendor bills through an Indian entity"
                  hint="AWS India and GoDaddy India do; DigitalOcean and Namecheap do not">
                  <input name="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className={inputClass} style={inputStyle} placeholder="Leave blank for a foreign-billed supplier" />
                </Field>
              </div>
            )}

            <Field label="PAN" hint={pan && !panOk ? 'Five letters, four digits, one letter' : 'The 4th character decides the 194C rate'}>
              <input name="pan" value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} className={inputClass} style={inputStyle} placeholder="ABCPD1234E" />
            </Field>

            <Field label="TDS section">
              <select name="defaultTdsSection" className={inputClass} style={inputStyle} defaultValue={initial?.defaultTdsSection ?? ''}>
                <option value="">None</option>
                {foreign
                  ? <option value="195">195 — payments to non-residents</option>
                  : <>
                      <option value="194J">194J — professional fees (10%)</option>
                      <option value="194J-TS">194J — technical services (2%)</option>
                      <option value="194C">194C — contract work (1% / 2%)</option>
                      <option value="194H">194H — commission (2%)</option>
                      <option value="194I-A">194I(a) — equipment / machinery rent (2%)</option>
                      <option value="194I-B">194I(b) — land, building, furniture rent (10%)</option>
                      <option value="194A">194A — interest (10%)</option>
                    </>}
              </select>
            </Field>

            <Field label="Email"><input name="email" type="email" defaultValue={initial?.email ?? ''} className={inputClass} style={inputStyle} /></Field>
            <Field label="Payment terms (days)"><input name="paymentTermDays" type="number" inputMode="numeric" defaultValue={initial?.paymentTermDays ?? 15} className={inputClass} style={inputStyle} /></Field>
          </div>

          <div className="mt-5 space-y-2.5">
            {rcm && (
              <Alert tone="warn" title="Reverse charge will apply">
                No Indian GSTIN, so bills from this vendor are an import of service. Adpedia
                self-accounts IGST at 18%, pays it in cash — never set off against existing ITC —
                and claims the same amount back as input credit. A self-invoice is generated
                under s.31(3)(f). Net cost is nil, provided it is done.
              </Alert>
            )}
            {pan === '' && (
              <Alert tone="critical" title="Without a PAN, TDS is 20%">
                Section 206AA overrides the normal rate and the annual threshold gives no relief.
                You can save the vendor now, but collect the PAN before paying them.
              </Alert>
            )}
            {foreign && (
              <Alert tone="info" title="Non-resident payments need 15CA/15CB">
                Form 15CA, and Form 15CB from a chartered accountant, are required
                <strong> before </strong>the remittance. The treaty rate also needs a Tax Residency
                Certificate and Form 10F from the payee.
              </Alert>
            )}
          </div>

          {state?.error && (
            <p className="mt-4 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
          )}

          <div className="mt-5 flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? 'Saving…' : submitLabel}</Button>
            <Link href="/vendors"><Button variant="ghost" type="button">Cancel</Button></Link>
          </div>
        </Card>
      </form>
    </div>
  )
}
