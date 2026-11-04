'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Card, Field, Button, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { createCreditNoteAction } from './actions'

const inr = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function CreditNoteForm({ invoiceId, invoiceNumber, today, creditable, creditableLabel, taxMode, ratePct }: {
  invoiceId: string; invoiceNumber: string; today: string
  creditable: string; creditableLabel: string; taxMode: string; ratePct: string
}) {
  const [state, action, pending] = useActionState(createCreditNoteAction, null)
  const [scope, setScope] = useState<'full' | 'partial'>('full')
  const [value, setValue] = useState('')

  const taxable = scope === 'full' ? Number(creditable) : Number(value) || 0
  const tax = Math.round(taxable * Number(ratePct)) / 100
  const total = taxable + tax

  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="scope" value={scope} />

      <Card className="space-y-4 p-5">
        <Field label="How much">
          <div className="flex gap-1.5 rounded-lg border p-1" style={{ borderColor: 'var(--rule)' }}>
            <Tab active={scope === 'full'} onClick={() => setScope('full')}>
              All of it — {creditableLabel}
            </Tab>
            <Tab active={scope === 'partial'} onClick={() => setScope('partial')}>Part of it</Tab>
          </div>
        </Field>

        {scope === 'partial' && (
          <Field label="Taxable value to credit" hint={`At most ${creditableLabel}`}>
            <input name="taxableValue" inputMode="decimal" value={value}
              onChange={(e) => setValue(e.target.value)} placeholder="0.00"
              className={inputClass} style={inputStyle} />
          </Field>
        )}

        <Field label="Date">
          <input type="date" name="date" defaultValue={today} required className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Reason" hint="Reported in GSTR-1 and read by the client — be specific">
          <input name="reason" required minLength={5}
            placeholder="Scope reduced by agreement dated 12 Oct"
            className={inputClass} style={inputStyle} />
        </Field>

        <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--surface)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span style={{ color: 'var(--text-muted)' }}>Credit against {invoiceNumber}</span>
            <Pill tone="neutral">
              {taxMode === 'INTRA' ? 'CGST + SGST' : taxMode === 'INTER' ? 'IGST' : 'zero-rated'}
            </Pill>
          </div>
          <dl className="mt-2 space-y-1 text-[13px]">
            <Row k="Taxable value" v={inr(taxable)} />
            {taxMode !== 'EXPORT' && <Row k={`GST @ ${ratePct}%`} v={inr(tax)} />}
            <Row k="Credit note total" v={inr(total)} strong />
          </dl>
        </div>

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || taxable <= 0}>{pending ? 'Issuing…' : 'Issue credit note'}</Button>
          <Link href={`/invoices/${invoiceId}`}><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t pt-1 font-semibold' : ''}`}
      style={strong ? { borderColor: 'var(--rule)' } : undefined}>
      <dt style={strong ? undefined : { color: 'var(--text-muted)' }}>{k}</dt>
      <dd className="tabular">{v}</dd>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-md px-3 py-1 text-[12.5px] font-medium"
      style={active ? { background: 'var(--accent)', color: '#fff' } : { color: 'var(--text-muted)' }}>
      {children}
    </button>
  )
}
