'use client'
import { useActionState, useState } from 'react'
import { importStatementAction } from '../actions'
import { Field, Button, inputClass, inputStyle } from '@/components/ui/kit'

export function ImportForm({ accounts }: { accounts: { id: string; label: string; accountNo: string }[] }) {
  const [state, action, pending] = useActionState(importStatementAction, null)
  const [failed, setFailed] = useState(false)

  return (
    <form action={action}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bank account">
          <select name="bankAccountId" required className={inputClass} style={inputStyle}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ····{a.accountNo.slice(-4)}</option>)}
          </select>
        </Field>
        <Field label="Statement format">
          <select name="profileKey" className={inputClass} style={inputStyle} defaultValue="AXIS">
            <option value="AXIS">Axis Bank</option>
            <option value="HDFC">HDFC Bank</option>
          </select>
        </Field>
        <Field label="Opening balance" hint="Only if the file does not carry it">
          <input name="openingBalance" inputMode="decimal" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Closing balance" hint="Only if the file does not carry it">
          <input name="closingBalance" inputMode="decimal" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <div className="mt-4">
        <textarea name="text" rows={10} required
          placeholder={'Transaction Date,Value Date,Particulars,Cheque Number,Amount(INR),Debit/Credit,Balance(INR)\n05/10/2026,05/10/2026,NEFT/HDFCH008/CLICK AR BUSINESS PRIVATE LI/HDFC BANK,,91800.00,CR,139106.25'}
          className={inputClass + ' font-mono text-[11.5px]'} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>

      {state?.error && (
        <>
          <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
          {state.error.includes('Balance check') && !failed && (
            <button type="button" onClick={() => setFailed(true)} className="mt-2 text-[12px] underline" style={{ color: 'var(--text-muted)' }}>
              Import anyway
            </button>
          )}
        </>
      )}
      {failed && (
        <label className="mt-3 flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--warn)' }}>
          <input type="checkbox" name="force" className="h-4 w-4" defaultChecked />
          Import despite the failed balance check — the figures may be wrong
        </label>
      )}
      {state?.ok && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>{state.ok}</p>}

      <div className="mt-4"><Button type="submit" disabled={pending}>{pending ? 'Importing…' : 'Import statement'}</Button></div>
    </form>
  )
}
