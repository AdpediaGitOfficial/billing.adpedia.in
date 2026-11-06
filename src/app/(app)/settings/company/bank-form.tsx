'use client'
import { useActionState } from 'react'
import { addBankAccountAction } from './actions'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'

/**
 * 🔴 docs/88 — until this existed, only the seed could create a bank account, so a second entity
 * printed "—" under Payment details and could not record a receipt at all.
 */
export function BankAccountForm({ first }: { first: boolean }) {
  const [state, action, pending] = useActionState(addBankAccountAction, null)

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name for this account" hint="How it is listed, e.g. “HDFC — Savings”">
          <input name="label" required className={inputClass} style={inputStyle} placeholder="HDFC — Savings" />
        </Field>
        <Field label="Bank">
          <input name="bankName" required className={inputClass} style={inputStyle} placeholder="HDFC Bank Ltd" />
        </Field>
        <Field label="Account number">
          <input name="accountNo" required inputMode="numeric" autoComplete="off" spellCheck={false}
            className={`${inputClass} tabular`} style={inputStyle} />
        </Field>
        <Field label="IFSC" hint="Leave empty for an overseas account">
          <input name="ifsc" maxLength={11} autoCapitalize="characters" spellCheck={false}
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="HDFC0000123" />
        </Field>
        <Field label="Branch" hint="Optional">
          <input name="branch" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="SWIFT code" hint="An overseas client needs this to pay you">
          <input name="swift" maxLength={11} autoCapitalize="characters" spellCheck={false}
            className={`${inputClass} uppercase`} style={inputStyle} placeholder="HDFCINBB" />
        </Field>
        <Field label="Account holder" hint="Leave empty to use the entity's name">
          <input name="accountName" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="UPI ID" hint="Optional">
          <input name="upiId" autoCapitalize="none" spellCheck={false} className={inputClass} style={inputStyle} placeholder="name@bank" />
        </Field>
      </div>

      {first ? (
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          This is the first account, so it becomes the default and prints on every invoice.
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px]">
          <label className="flex items-center gap-2"><input type="checkbox" name="showOnInvoice" /> Print on invoices instead</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="makeDefault" /> Make it the default for receipts</label>
        </div>
      )}

      {state?.error && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--good-soft, var(--surface))', color: 'var(--good)' }}>{state.ok}</p>
      )}
      <Button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add bank account'}</Button>
    </form>
  )
}
