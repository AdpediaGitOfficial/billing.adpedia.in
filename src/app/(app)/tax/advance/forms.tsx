'use client'
import { useActionState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { setEstimateAction, recordAdvanceTaxAction } from './actions'

export function EstimateForm({ financialYearId, current }: { financialYearId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setEstimateAction, null)
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="financialYearId" value={financialYearId} />
      <Field label="Estimated tax for the year" hint="The CA's figure for the whole year, not the instalment">
        <input name="estimatedAnnualTax" required inputMode="decimal" defaultValue={current ?? ''}
          className={inputClass} style={inputStyle} placeholder="600000" />
      </Field>
      <Field label="Who gave it, and on what basis" hint="Required — it is a number nobody can derive from the books">
        <input name="source" required className={inputClass} style={inputStyle} placeholder="R Menon & Co, after Q2" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Note">
          <input name="note" className={inputClass} style={inputStyle}
            placeholder="Assumes s.115BAA at 22%; excludes the disallowance under discussion" />
        </Field>
      </div>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending}>{pending ? 'Saving…' : current ? 'Revise the estimate' : 'Record the estimate'}</Button>
        {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
        {state?.ok && <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>}
      </div>
    </form>
  )
}

export function PaymentForm() {
  const [state, action, pending] = useActionState(recordAdvanceTaxAction, null)
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-4">
      <Field label="Paid on"><input name="paidOn" type="date" required className={inputClass} style={inputStyle} /></Field>
      <Field label="Amount"><input name="amount" required inputMode="decimal" className={inputClass} style={inputStyle} /></Field>
      <Field label="BSR code" hint="7 digits, on the counterfoil">
        <input name="bsrCode" required inputMode="numeric" className={inputClass} style={inputStyle} placeholder="0510308" />
      </Field>
      <Field label="Challan serial" hint="up to 5 digits">
        <input name="challanSerial" required inputMode="numeric" className={inputClass} style={inputStyle} placeholder="00011" />
      </Field>
      <div className="sm:col-span-4 flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending}>{pending ? 'Saving…' : 'Record the payment'}</Button>
        {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
        {state?.ok && <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>}
      </div>
    </form>
  )
}
