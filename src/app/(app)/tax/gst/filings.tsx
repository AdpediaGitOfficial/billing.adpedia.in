'use client'
import { useActionState, useState } from 'react'
import { Card, Button, Field, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { recordFilingAction, unrecordFilingAction } from './filing-actions'

export interface FilingView {
  id: string; returnType: string; periodLabel: string
  filedOn: string | null; arn: string | null; status: string; netPayable: string
}

export function Filings({ filings, periods }: {
  filings: FilingView[]
  periods: { label: string }[]
}) {
  const [recordState, record, recording] = useActionState(recordFilingAction, null)
  const [undoState, undo, undoing] = useActionState(unrecordFilingAction, null)
  const [open, setOpen] = useState(false)

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[14px] font-semibold">Filing record</p>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Recording a return as filed <strong>locks that period</strong> — after filing, a change
            inside it would make the filed return wrong without anything saying so.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Record a filing'}
        </Button>
      </div>

      {open && (
        <form action={record} className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
          <Field label="Return">
            <select name="returnType" className={inputClass} style={inputStyle}>
              <option value="GSTR1">GSTR-1</option>
              <option value="GSTR3B">GSTR-3B</option>
            </select>
          </Field>
          <Field label="Period">
            <select name="periodLabel" className={inputClass} style={inputStyle}>
              {periods.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Filed on">
            <input type="date" name="filedOn" required className={inputClass} style={inputStyle} />
          </Field>
          <Field label="ARN" hint="From the portal acknowledgement">
            <input name="arn" placeholder="AD320726001234A" autoCapitalize="characters"
              className={inputClass} style={inputStyle} />
          </Field>
          <div className="sm:col-span-4">
            <Button disabled={recording}>{recording ? 'Recording…' : 'Record filing'}</Button>
          </div>
        </form>
      )}

      {(recordState || undoState) && (
        <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
          style={{
            background: 'var(--surface)',
            color: (recordState?.error ?? undoState?.error) ? 'var(--critical)' : 'var(--good)',
          }}>
          {recordState?.error ?? recordState?.ok ?? undoState?.error ?? undoState?.ok}
        </p>
      )}

      {filings.length === 0 ? (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          Nothing recorded yet. Until a return is recorded here the compliance calendar keeps
          asking for it, and the period stays open to changes.
        </p>
      ) : (
        <table className="mt-3 w-full text-[12.5px]">
          <tbody>
            {filings.map((f) => (
              <tr key={f.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                <td className="py-2">
                  <span className="font-medium">{f.returnType.replace('GSTR', 'GSTR-')}</span>
                  <span className="ml-2" style={{ color: 'var(--text-muted)' }}>{f.periodLabel}</span>
                </td>
                <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>
                  {f.filedOn ?? '—'}{f.arn ? ` · ${f.arn}` : ''}
                </td>
                <td className="py-2 text-right">
                  <Pill tone={f.status === 'FILED' ? 'good' : 'neutral'}>{f.status.toLowerCase()}</Pill>
                </td>
                <td className="py-2 text-right">
                  {f.status === 'FILED' && (
                    <form action={undo} className="inline-flex items-center gap-1.5">
                      <input type="hidden" name="id" value={f.id} />
                      <input name="reason" placeholder="why?" required minLength={5}
                        className="w-28 rounded border px-1.5 py-0.5 text-[11px]"
                        style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }} />
                      <button disabled={undoing} className="text-[11px] underline"
                        style={{ color: 'var(--text-muted)' }}>remove</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
