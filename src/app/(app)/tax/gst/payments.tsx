'use client'
import { useActionState, useState } from 'react'
import { Card, Button, Field, Pill, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { recordPaymentAction } from './filing-actions'

export interface ChallanView {
  id: string; periodLabel: string; cin: string | null; paidOn: string
  amount: string; interest: string; lateFee: string
}

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function Payments({ challans, periods }: {
  challans: ChallanView[]
  periods: { label: string }[]
}) {
  const [state, action, pending] = useActionState(recordPaymentAction, null)
  const [open, setOpen] = useState(false)

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[14px] font-semibold">Payments</p>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Filing a return and paying the tax are different events. A return recorded as filed
            with no challan against it is <strong>not settled</strong> &mdash; and the interest keeps running.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Record a payment'}
        </Button>
      </div>

      {open && (
        <form action={action} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Period">
              <select name="periodLabel" className={inputClass} style={inputStyle}>
                {periods.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="Paid on">
              <input type="date" name="paidOn" required className={inputClass} style={inputStyle} />
            </Field>
            <Field label="CPIN" hint="When the challan was generated">
              <input name="cpin" className={inputClass} style={inputStyle} />
            </Field>
            <Field label="CIN" hint="Required — the bank's confirmation">
              <input name="cin" required className={inputClass} style={inputStyle} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-6">
            <Field label="CGST"><input name="cgst" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
            <Field label="SGST"><input name="sgst" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
            <Field label="IGST"><input name="igst" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
            <Field label="RCM" hint="cash only"><input name="rcm" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
            <Field label="Interest"><input name="interest" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
            <Field label="Late fee"><input name="lateFee" inputMode="decimal" placeholder="0" className={inputClass} style={inputStyle} /></Field>
          </div>

          <Alert tone="info" title="Interest runs on the cash component only">
            Under the proviso to s.50(1) interest is charged on tax paid through the cash ledger,
            not on the part set off against input credit. It is 18% a year, <strong>per day</strong> &mdash;
            unlike TDS, where a single day costs a whole month.
          </Alert>

          <Button disabled={pending}>{pending ? 'Recording…' : 'Record payment'}</Button>
        </form>
      )}

      {state && (
        <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--surface)', color: state.error ? 'var(--critical)' : 'var(--good)' }}>
          {state.error ?? state.ok}
        </p>
      )}

      {challans.length === 0 ? (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          No challans recorded. Until one is, the compliance calendar treats the tax as unpaid.
        </p>
      ) : (
        <table className="mt-3 w-full text-[12.5px]">
          <tbody>
            {challans.map((c) => (
              <tr key={c.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-2 font-medium">{c.periodLabel}</td>
                <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>
                  {c.paidOn}{c.cin ? ` · ${c.cin}` : ''}
                </td>
                <td className="py-2 text-right">
                  {Number(c.interest) + Number(c.lateFee) > 0 && (
                    <Pill tone="warn">+{inr(String(Number(c.interest) + Number(c.lateFee)))} interest</Pill>
                  )}
                </td>
                <td className="py-2 text-right font-semibold tabular">{inr(c.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
