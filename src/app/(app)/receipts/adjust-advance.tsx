'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle, tapTarget } from '@/components/ui/kit'
import { adjustAdvanceAction } from './advance/actions'

/** `outstanding` arrives already formatted — the list is rendered on the server. */
export interface OpenInvoice { id: string; number: string; outstanding: string }

/**
 * Absorb an advance into an invoice — docs/54.
 *
 * 🔴 Offered only against invoices for the SAME customer, because an advance belongs to the
 * person who paid it. The service refuses anything else; this just does not offer it.
 */
export function AdjustAdvance({ receiptId, open, invoices }: {
  receiptId: string
  open: string
  invoices: OpenInvoice[]
}) {
  const [state, action, pending] = useActionState(adjustAdvanceAction, null)
  const [showing, setShowing] = useState(false)

  if (state?.ok) {
    return <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>
  }

  if (invoices.length === 0) {
    return <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>no open invoice</span>
  }

  if (!showing) {
    return (
      <button type="button" onClick={() => setShowing(true)}
        className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--accent)' }}>
        adjust
      </button>
    )
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="receiptId" value={receiptId} />
      <Field label="Against">
        <select name="invoiceId" className={inputClass} style={inputStyle}>
          {invoices.map((i) => (
            <option key={i.id} value={i.id}>{i.number} — {i.outstanding} open</option>
          ))}
        </select>
      </Field>
      <Field label="Amount">
        <input name="amount" inputMode="decimal" defaultValue={open} className={`${inputClass} w-32`} style={inputStyle} />
      </Field>
      <Field label="Date">
        <input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)}
          className={inputClass} style={inputStyle} />
      </Field>
      <Button size="sm" variant="ghost" disabled={pending}>{pending ? 'Adjusting…' : 'Adjust'}</Button>
      <button type="button" onClick={() => setShowing(false)}
        className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>back</button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}
