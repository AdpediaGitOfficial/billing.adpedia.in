'use client'
import { Fragment, useActionState, useState } from 'react'
import { Card, CardHeader, Button, Field, Pill, Alert, inputClass, inputStyle, tapTarget } from '@/components/ui/kit'
import { recordTdsFilingAction, recordCorrectionAction } from './actions'

export interface FilingRow {
  id: string
  formType: string
  quarter: number
  filedOn: string
  token: string | null
  deducteeCount: number
  tdsDeducted: string
  tdsDeposited: string
  corrections: { id: string; category: string; label: string; filedOn: string; reason: string }[]
}

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Recording that a quarterly TDS return was filed — docs/50.
 *
 * 🔴 It is not bookkeeping for its own sake. A filed return reports every deduction in it
 * against the deductee's PAN, where it shows up in their Form 26AS and they claim it. That is
 * precisely what makes the payroll run behind it, and the challan quoted in it, impossible to
 * cancel here — so this record is what the refusals are made of.
 */
export function TdsFilings({ filings, quarter, form }: {
  filings: FilingRow[]
  quarter: number
  form: string
}) {
  const [state, action, pending] = useActionState(recordTdsFilingAction, null)
  const [correction, correctionAction, correcting] = useActionState(recordCorrectionAction, null)
  const [open, setOpen] = useState(false)
  const [correctingId, setCorrectingId] = useState<string | null>(null)

  const already = filings.find((f) => f.quarter === quarter && f.formType === form)

  return (
    <Card className="p-4">
      <CardHeader
        title="Filing record"
        sub="A filed return is reported against each deductee’s PAN — it is what the cancellations here refuse on."
        action={already
          ? <Pill tone="good" dot>{form} Q{quarter} filed</Pill>
          : <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
              {open ? 'Close' : 'Record a filing'}
            </Button>} />

      {open && !already && (
        <form action={action} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Form">
              <select name="formType" defaultValue={form} className={inputClass} style={inputStyle}>
                <option value="24Q">24Q — salary</option>
                <option value="26Q">26Q — residents</option>
                <option value="27Q">27Q — non-residents</option>
              </select>
            </Field>
            <Field label="Quarter">
              <select name="quarter" defaultValue={String(quarter)} className={inputClass} style={inputStyle}>
                {[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}
              </select>
            </Field>
            <Field label="Filed on">
              <input type="date" name="filedOn" required className={inputClass} style={inputStyle} />
            </Field>
            <Field label="Provisional receipt no." hint="15 digits, from the acknowledgement">
              <input name="token" inputMode="numeric" maxLength={15} className={inputClass} style={inputStyle} />
            </Field>
          </div>

          <Alert tone="warn" title="Recording this locks the quarter against cancellation">
            Once a quarter is filed, the payroll runs and challans behind it cannot be reversed here —
            the deductees are already claiming the credit. A correction after that is a revised return.
          </Alert>

          <Button disabled={pending}>{pending ? 'Recording…' : 'Record filing'}</Button>
        </form>
      )}

      {correction && (
        <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--surface)', color: correction.error ? 'var(--critical)' : 'var(--good)' }}>
          {correction.error ?? correction.ok}
        </p>
      )}

      {state && (
        <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--surface)', color: state.error ? 'var(--critical)' : 'var(--good)' }}>
          {state.error ?? state.ok}
        </p>
      )}

      {filings.length === 0 ? (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          No return recorded as filed yet. Until one is, the compliance calendar keeps asking for it —
          and a payroll run or challan can still be reversed.
        </p>
      ) : (
        <table className="mt-3 w-full text-[12.5px]">
          <tbody>
            {filings.map((f) => (
              <Fragment key={f.id}>
                <tr className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 font-medium">{f.formType} · Q{f.quarter}</td>
                  <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>
                    {f.filedOn}{f.token ? ` · ${f.token}` : ''}
                  </td>
                  <td className="py-2 text-right" style={{ color: 'var(--text-muted)' }}>
                    {f.deducteeCount} deductee{f.deducteeCount === 1 ? '' : 's'}
                  </td>
                  <td className="py-2 text-right font-semibold tabular">{inr(f.tdsDeducted)}</td>
                  <td className="py-2 pl-3 text-right">
                    <button type="button" onClick={() => setCorrectingId(correctingId === f.id ? null : f.id)}
                      className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>
                      {correctingId === f.id ? 'back' : 'correct'}
                    </button>
                  </td>
                </tr>

                {f.corrections.map((c) => (
                  <tr key={c.id}>
                    <td />
                    <td colSpan={4} className="pb-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      ↳ {c.label} · filed {c.filedOn} · {c.reason}
                    </td>
                  </tr>
                ))}

                {correctingId === f.id && (
                  <tr>
                    <td colSpan={5} className="pb-3">
                      {/* 🔴 The corrected figures are what the return reports AFTER the
                          statement. They replace the snapshot the cancellation guards read,
                          which is how a correction re-opens what it corrects and nothing else. */}
                      <form action={correctionAction} className="space-y-3 rounded-lg p-3"
                        style={{ background: 'var(--surface)' }}>
                        <input type="hidden" name="filingId" value={f.id} />
                        <div className="grid gap-3 sm:grid-cols-4">
                          <Field label="Category">
                            <select name="category" defaultValue="C3" className={inputClass} style={inputStyle}>
                              <option value="C1">C1 — deductor details</option>
                              <option value="C2">C2 — challan details</option>
                              <option value="C3">C3 — deductee details</option>
                              <option value="C4">C4 — salary details</option>
                              <option value="C5">C5 — PAN correction</option>
                              <option value="C9">C9 — challan added</option>
                            </select>
                          </Field>
                          <Field label="Filed on">
                            <input type="date" name="filedOn" required className={inputClass} style={inputStyle} />
                          </Field>
                          <Field label="TDS now reported" hint="after the correction">
                            <input name="tdsDeducted" inputMode="decimal" defaultValue={f.tdsDeducted}
                              className={inputClass} style={inputStyle} />
                          </Field>
                          <Field label="Deposited now reported">
                            <input name="tdsDeposited" inputMode="decimal" defaultValue={f.tdsDeposited}
                              className={inputClass} style={inputStyle} />
                          </Field>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Receipt no. of the correction" hint="15 digits, optional">
                            <input name="token" inputMode="numeric" maxLength={15} className={inputClass} style={inputStyle} />
                          </Field>
                          <Field label="Reason">
                            <input name="reason" required minLength={5} className={inputClass} style={inputStyle}
                              placeholder="Deductee removed — the payroll run was never payable" />
                          </Field>
                        </div>
                        <Button size="sm" disabled={correcting}>
                          {correcting ? 'Recording…' : 'Record correction'}
                        </Button>
                      </form>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
