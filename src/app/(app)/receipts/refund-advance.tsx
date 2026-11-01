'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle, tapTarget } from '@/components/ui/kit'
import { refundAdvanceAction } from './advance/actions'

/**
 * Give an advance back — docs/65.
 *
 * 🔴 A separate control from "adjust", not a mode on it. Adjusting an advance against an
 * invoice and returning it to the client are opposite outcomes with opposite documents, and
 * one form with a switch is how somebody refunds a client who was in fact invoiced.
 */
export function RefundAdvance({ receiptId, open }: { receiptId: string; open: string }) {
  const [state, action, pending] = useActionState(refundAdvanceAction, null)
  const [showing, setShowing] = useState(false)

  if (state?.ok) {
    return <span className="block text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>
  }

  if (!showing) {
    return (
      <button type="button" onClick={() => setShowing(true)}
        className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>
        refund it
      </button>
    )
  }

  return (
    <form action={action} className="mt-1 space-y-2 rounded-lg p-2.5" style={{ background: 'var(--surface)' }}>
      <input type="hidden" name="receiptId" value={receiptId} />
      <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        Returning an advance with no supply made. A refund voucher is issued under s.31(3)(e), and the
        GST declared when the money arrived comes back in this period&rsquo;s return.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Amount returned" hint={`₹${open} available`}>
          <input name="amount" required inputMode="decimal" defaultValue={open}
            className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Date">
          <input type="date" name="date" required className={inputClass} style={inputStyle} />
        </Field>
      </div>
      <Field label="Why" hint="rule 51 requires it on the document">
        <input name="reason" required minLength={5} placeholder="Project cancelled before it began"
          className={inputClass} style={inputStyle} />
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending}>{pending ? 'Issuing…' : 'Issue refund voucher'}</Button>
        <button type="button" onClick={() => setShowing(false)}
          className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>cancel</button>
      </div>
      {state?.error && <p className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</p>}
    </form>
  )
}
