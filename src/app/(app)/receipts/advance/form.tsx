'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Card, Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { createAdvanceAction } from './actions'

/** Indian grouping, as every other screen shows money — ₹1,18,000.00, not ₹118000.00. */
const inr = (v: number) =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function AdvanceForm({ customers, today }: {
  customers: { id: string; name: string; stateCode: string | null; country: string }[]
  today: string
}) {
  const [state, action, pending] = useActionState(createAdvanceAction, null)
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [rate, setRate] = useState('18')

  const customer = customers.find((c) => c.id === customerId)
  const isExport = customer && customer.country !== 'IN'
  const unknownState = customer && customer.country === 'IN' && !customer.stateCode

  // the same arithmetic the server does, so the figure is visible before saving
  const gross = Number(amount || 0)
  const r = isExport ? 0 : Number(rate || 18)
  const taxable = gross > 0 ? gross * 100 / (100 + r) : 0
  const tax = gross - taxable

  return (
    <form action={action}>
      <Card className="space-y-4 p-5">
        <Field label="Customer">
          <select name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)}
            className={inputClass} style={inputStyle}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* 🔴 the marker belongs in the code, not on screen — docs/50 §5 */}
          <Field label="Amount received" hint="GST-inclusive — the advance is deemed to include the tax">
            <input name="amount" inputMode="decimal" required value={amount}
              onChange={(e) => setAmount(e.target.value)} className={inputClass} style={inputStyle} />
          </Field>
          <Field label="Date">
            <input type="date" name="date" required defaultValue={today} className={inputClass} style={inputStyle} />
          </Field>
          <Field label="Mode">
            <select name="mode" className={inputClass} style={inputStyle} defaultValue="NEFT">
              {['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'SWIFT', 'OTHER'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Reference / UTR"><input name="reference" className={inputClass} style={inputStyle} /></Field>
          {!isExport && (
            <Field label="GST rate" hint="Rule 50: 18% where it is not determinable yet">
              <input name="gstRatePct" inputMode="decimal" value={rate}
                onChange={(e) => setRate(e.target.value)} className={inputClass} style={inputStyle} />
            </Field>
          )}
          <Field label="TDS withheld" hint="If the client deducted on the advance">
            <input name="tdsAmount" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} />
          </Field>
        </div>

        <Field label="What it is for" hint="Appears on the receipt voucher">
          <input name="description" className={inputClass} style={inputStyle} placeholder="Advance for the Q2 engagement" />
        </Field>

        {gross > 0 && (
          <Alert tone={isExport ? 'info' : 'warn'}
            title={isExport
              ? 'Zero-rated — no GST falls due on this advance'
              : `${inr(tax)} of GST falls due in this period`}>
            {isExport ? (
              <>An export of services is zero-rated, so the advance carries no tax. It is still a receipt
              voucher under s.31(3)(d), and the FIRC follows the money.</>
            ) : (
              <>{inr(taxable)} of taxable value and {inr(tax)} of tax, backed out of the
              {' '}{inr(gross)} received. Tax on an advance for <strong>services</strong> is payable when the
              money arrives (s.13(2)); the relief in Notification 66/2017 covers goods only.
              {unknownState && <> This customer has no state on file, so it is charged as inter-state — rule 50.</>}</>
            )}
          </Alert>
        )}

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <div className="flex gap-2">
          <Button disabled={pending}>{pending ? 'Recording…' : 'Record advance'}</Button>
          <Link href="/receipts"><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
