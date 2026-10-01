'use client'
import { useActionState } from 'react'
import { import26asAction } from './actions'
import { Button, inputClass, inputStyle } from '@/components/ui/kit'

const SAMPLE = `Sr,Name of Deductor,TAN,Section,Transaction Date,Status,Amount Paid,Tax Deducted
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,20-Aug-2026,F,85000.00,8500.00`

export function Import26asForm() {
  const [state, action, pending] = useActionState(import26asAction, null)
  return (
    <form action={action}>
      <textarea name="text" rows={6} required placeholder={SAMPLE}
        className={inputClass + ' font-mono text-[12px]'} style={{ ...inputStyle, resize: 'vertical' }} />

      <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        Each row needs a deductor TAN, a section code and two amounts. Anything unreadable is
        reported rather than dropped — a skipped row is a missing tax credit.
      </p>

      {state?.error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>}
      {state?.ok && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>{state.ok}</p>}

      <div className="mt-4"><Button type="submit" disabled={pending}>{pending ? 'Importing…' : 'Import and reconcile'}</Button></div>
    </form>
  )
}
