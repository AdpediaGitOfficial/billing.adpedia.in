'use client'
import { useActionState, useState } from 'react'
import { Button, inputClass, inputStyle } from '@/components/ui/kit'
import { cancelReceiptAction } from './actions'

/**
 * 🔴 Cancelling posts a REVERSING entry and puts every invoice it touched back. It is not an
 * edit and not a delete, so the reason is required — it is the only record of why the figures
 * moved, and it is read by whoever asks that question later.
 */
export function CancelReceiptButton({ receiptId, number }: { receiptId: string; number: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [state, action, pending] = useActionState(cancelReceiptAction, null)

  if (state?.ok) {
    return <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
        cancel
      </button>
    )
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="receiptId" value={receiptId} />
      <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={`Why is ${number} being reversed?`} required minLength={5}
        className={`${inputClass} w-64`} style={inputStyle} />
      <Button size="sm" variant="ghost" disabled={pending || reason.trim().length < 5}>
        {pending ? 'Reversing…' : 'Confirm'}
      </Button>
      <button type="button" onClick={() => setOpen(false)}
        className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>back</button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}
