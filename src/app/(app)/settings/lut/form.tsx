'use client'
import { useActionState } from 'react'
import { addLutAction } from './actions'
import { Field, Button, inputClass, inputStyle } from '@/components/ui/kit'

export function LutForm({ defaultFy }: { defaultFy: string }) {
  const [state, action, pending] = useActionState(addLutAction, null)
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <Field label="ARN" hint="From the GST portal — the form AD320325043063O">
          <input name="arn" required placeholder="AD320326……" className={inputClass} style={inputStyle} />
        </Field>
      </div>
      <Field label="Financial year">
        <input name="fyLabel" required defaultValue={defaultFy} placeholder="2026-27" className={inputClass} style={inputStyle} />
      </Field>
      <Field label="Filed on">
        <input name="filedOn" type="date" className={inputClass} style={inputStyle} />
      </Field>

      <div className="sm:col-span-3">
        {state?.error && (
          <p className="mb-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>
            {state.error}
          </p>
        )}
        {state?.ok && (
          <p className="mb-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>
            LUT saved. Export invoices for this year can now be sent zero-rated.
          </p>
        )}
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Add LUT'}</Button>
      </div>
    </form>
  )
}
