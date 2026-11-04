'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { Card, Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { amendInvoiceAction } from './actions'

const STATES = [['32', 'Kerala'], ['29', 'Karnataka'], ['33', 'Tamil Nadu'], ['27', 'Maharashtra'], ['07', 'Delhi'], ['36', 'Telangana'], ['24', 'Gujarat']]

/**
 * 🔴 Everything here is what the invoice SHOULD have said. Nothing on this form edits the
 * invoice: it is reported in a later return against the original number and date, and the
 * original stays exactly as the client and the portal hold it.
 */
export function AmendForm({ invoiceId, invoiceNumber, today, current }: {
  invoiceId: string
  invoiceNumber: string
  today: string
  current: { gstin: string | null; stateCode: string | null; taxableValue: string }
}) {
  const [state, action, pending] = useActionState(amendInvoiceAction, null)

  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Card className="space-y-4 p-5">
        <Field label="Reported on" hint="The date decides which return carries the amendment — it must be a later one">
          <input type="date" name="date" required defaultValue={today} className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Recipient GSTIN, as it should have been">
          <input name="gstin" defaultValue={current.gstin ?? ''} autoCapitalize="characters" spellCheck={false}
            className={`${inputClass} uppercase`} style={inputStyle} />
        </Field>

        <Field label="Place of supply, as it should have been"
          hint="Changing this moves the tax between CGST/SGST and IGST — the value does not change">
          <select name="stateCode" defaultValue={current.stateCode ?? ''} className={inputClass} style={inputStyle}>
            {STATES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
          </select>
        </Field>

        <Field label="Taxable value, as it should have been" hint="Leave as it is unless the value itself was keyed wrong">
          <input name="taxableValue" inputMode="decimal" defaultValue={current.taxableValue}
            className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Reason" hint="Reported in GSTR-1 and read by the client">
          <input name="reason" required minLength={5} className={inputClass} style={inputStyle}
            placeholder="Place of supply keyed as Kerala; the recipient is in Karnataka" />
        </Field>

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <Alert tone="info" title="A value reduction is a credit note, not an amendment">
          Where the parties agree the invoice was for too much, the instrument is a credit note under
          s.34 — it has its own number and the client needs a copy. An amendment corrects what was
          <strong> reported</strong> about {invoiceNumber}, not what was agreed.
        </Alert>

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending}>{pending ? 'Recording…' : 'Record amendment'}</Button>
          <Link href={`/invoices/${invoiceId}`}><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
