'use client'
import { useActionState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { amendNoteAction } from './actions'

/**
 * Amending a filed note — docs/66.
 *
 * 🔴 Only the taxable value can be changed, unlike an invoice amendment. A note's heads
 * follow the invoice it credits, and its recipient and place of supply are the invoice's —
 * offering to change them here would be offering to correct the wrong document.
 */
export function AmendNoteForm({ noteId, today, taxableValue }: {
  noteId: string; today: string; taxableValue: string
}) {
  const [state, action, pending] = useActionState(amendNoteAction, null)
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="noteId" value={noteId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reported on" hint="the return that carries the amendment">
          <input type="date" name="date" required defaultValue={today} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Taxable value as it should have been">
          <input name="taxableValue" inputMode="decimal" defaultValue={taxableValue}
            className={inputClass} style={inputStyle} />
        </Field>
      </div>
      <Field label="Why" hint="reported in GSTR-1 and read by the client">
        <input name="reason" required minLength={5} placeholder="The agreed reduction was ₹30,000, not ₹20,000"
          className={inputClass} style={inputStyle} />
      </Field>
      {state?.error && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
      )}
      <Button disabled={pending}>{pending ? 'Recording…' : 'Record the amendment'}</Button>
    </form>
  )
}
