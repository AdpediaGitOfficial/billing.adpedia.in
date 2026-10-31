'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { importStatementAction } from './actions'

const KINDS = [
  { value: 'GST_CASH_LEDGER', label: 'Electronic cash ledger (PMT-05)',
    hint: 'Services → Ledgers → Electronic Cash Ledger. One major head and its balance to a line, or paste the closing row.',
    sample: 'Integrated Tax,0.00\nCentral Tax,5000.00\nState/UT Tax,5000.00\nInterest,0.00' },
  { value: 'GST_CREDIT_LEDGER', label: 'Electronic credit ledger',
    hint: 'Services → Ledgers → Electronic Credit Ledger. This one is not expected to match the books — see the note above.',
    sample: 'Integrated Tax,9000.00\nCentral Tax,9000.00\nState/UT Tax,9000.00' },
  { value: 'GST_CHALLANS', label: 'GST challan history',
    hint: 'Services → Payments → Challan History. Each line needs a CIN and an amount.',
    sample: '1,26072000012345XYZ,20-07-2026,10000.00' },
  { value: 'GST_2B', label: 'GSTR-2B — input credit, invoice by invoice',
    hint: 'Returns → GSTR-2B → Download → JSON. Paste the whole file: it carries the portal’s own verdict on each invoice, which a hand-made sheet does not.',
    sample: '{"data":{"docdata":{"b2b":[{"ctin":"32AABCE1234F1Z5","trdnm":"Exalture Software Lab","inv":[…]}]}}}' },
  { value: 'TDS_CHALLANS', label: 'OLTAS challan status enquiry',
    hint: 'tin.tin.nsdl.com → Challan Status Enquiry → TAN based view. Each line needs a CIN or a 7-digit BSR code, and an amount.',
    sample: '1,05103080709202602001,0510308,02001,07-09-2026,18000.00' },
] as const

const today = () => new Date().toISOString().slice(0, 10)

/**
 * 🔴 The date asked for is the date the PORTAL'S figures are as at, not today. A statement
 * downloaded on Monday showing Friday's position, filed under Monday, compares our Monday
 * balance against the portal's Friday one and reports a difference that is not there.
 */
export function ImportStatement({ gstRegistered = true }: { gstRegistered?: boolean }) {
  const [state, action, pending] = useActionState(importStatementAction, null)
  // docs/82 §4 — an unregistered entity has only OLTAS to compare itself against
  const kinds = gstRegistered ? KINDS : KINDS.filter((k) => !k.value.startsWith('GST_'))
  const [kind, setKind] = useState<string>(kinds[0].value)
  const chosen = kinds.find((k) => k.value === kind) ?? kinds[0]

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Which statement">
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}
            className={inputClass} style={inputStyle}>
            {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Portal figures as at" hint="the date on the download, not today">
          <input type="date" name="asOn" required defaultValue={today()} max={today()}
            className={inputClass} style={inputStyle} />
        </Field>
        <Field label="File name" hint="optional, for the record">
          <input name="filename" placeholder="cash-ledger-30-09-2026.csv" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <textarea name="text" rows={6} required placeholder={chosen.sample}
        className={inputClass + ' font-mono text-[12px]'} style={{ ...inputStyle, resize: 'vertical' }} />

      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {chosen.hint} Anything unreadable is reported rather than dropped — a head read wrongly is a
        reconciliation that passes while the books are out.
      </p>

      {state?.error && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>{state.ok}</p>
      )}

      <Button type="submit" disabled={pending}>{pending ? 'Reading…' : 'Import and compare'}</Button>
    </form>
  )
}
