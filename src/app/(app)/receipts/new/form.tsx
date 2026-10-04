'use client'
import { useActionState, useMemo, useState } from 'react'
import Link from 'next/link'
import { Card, Button, Field, Pill, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { createReceiptAction } from '../actions'
import { settleInFull as proposeSettlement } from '@/lib/settlement'

interface OpenInvoice {
  id: string; number: string
  customerId: string; customerName: string
  date: string; dueDate: string
  outstanding: string; tdsExpected: string; tdsSection: string | null
}

const MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'SWIFT', 'OTHER'] as const

const n = (v: string) => (Number(v) || 0)
const inr = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ReceiptForm({ invoices, banks, preselect }: {
  invoices: OpenInvoice[]
  banks: { id: string; label: string; isDefault: boolean }[]
  /** An invoice id from `?invoice=`, already checked against `invoices` by the page. */
  preselect?: string
}) {
  const [state, action, pending] = useActionState(createReceiptAction, null)

  const customers = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of invoices) m.set(i.customerId, i.customerName)
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [invoices])

  const chosen = preselect ? invoices.find((i) => i.id === preselect) : undefined
  const [customerId, setCustomerId] = useState(chosen?.customerId ?? customers[0]?.id ?? '')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [mode, setMode] = useState<string>('NEFT')
  const [reference, setReference] = useState('')
  const [bankCharge, setBankCharge] = useState('')
  const [rows, setRows] = useState<Record<string, { amount: string; tds: string }>>(() => {
    if (!chosen) return {}
    const s = proposeSettlement(chosen.outstanding, chosen.tdsExpected)
    return { [chosen.id]: { amount: s.amount.toFixed(2), tds: s.tds.toFixed(2) } }
  })

  const mine = invoices.filter((i) => i.customerId === customerId)
  const get = (id: string) => rows[id] ?? { amount: '', tds: '' }
  const set = (id: string, patch: Partial<{ amount: string; tds: string }>) =>
    setRows((r) => ({ ...r, [id]: { ...get(id), ...patch } }))

  /**
   * 🔴 The move that makes this form usable — see `lib/settlement.ts` for why.
   *
   * The arithmetic lives there rather than here precisely so the manual path and the bank
   * matcher cannot drift apart: both are answering the same question, which is what a client
   * paying net of TDS actually sends.
   */
  function settleInFull(i: OpenInvoice) {
    const s = proposeSettlement(i.outstanding, i.tdsExpected)
    set(i.id, { amount: s.amount.toFixed(2), tds: s.tds.toFixed(2) })
  }

  const totalCash = mine.reduce((a, i) => a + n(get(i.id).amount), 0)
  const totalTds = mine.reduce((a, i) => a + n(get(i.id).tds), 0)

  const overAllocated = mine.filter((i) => n(get(i.id).amount) + n(get(i.id).tds) > n(i.outstanding) + 0.5)

  const payload = JSON.stringify(
    mine.map((i) => ({ invoiceId: i.id, amount: get(i.id).amount || '0', tdsAmount: get(i.id).tds || '0' })),
  )

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="allocations" value={payload} />
      <input type="hidden" name="customerId" value={customerId} />

      <Card className="space-y-4 p-5">
        <Field label="Client">
          <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setRows({}) }}
            className={inputClass} style={inputStyle}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date received">
            <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)}
              required className={inputClass} style={inputStyle} />
          </Field>
          <Field label="Mode">
            <select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}
              className={inputClass} style={inputStyle}>
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" hint={mode === 'CHEQUE' ? 'Cheque number' : 'UTR or transaction reference'}>
            <input name="reference" value={reference} onChange={(e) => setReference(e.target.value)}
              className={inputClass} style={inputStyle} />
          </Field>
          <Field label="Bank charge" hint="Optional — deducted by the bank on the way in">
            <input name="bankCharge" inputMode="decimal" value={bankCharge}
              onChange={(e) => setBankCharge(e.target.value)} placeholder="0.00"
              className={inputClass} style={inputStyle} />
          </Field>
        </div>

        {banks.length > 1 && (
          <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            Booked to {banks.find((b) => b.isDefault)?.label ?? banks[0].label}.
          </p>
        )}
      </Card>

      <Card flush className="overflow-hidden">
        <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          <span className="eyebrow">Allocate against open invoices</span>
        </div>

        {mine.map((i) => {
          const r = get(i.id)
          const left = n(i.outstanding) - n(r.amount) - n(r.tds)
          return (
            <div key={i.id} className="border-t px-4 py-3" style={{ borderColor: 'var(--rule)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/invoices/${i.id}`} className="text-[13px] font-semibold hover:underline">{i.number}</Link>
                  <span className="ml-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    due {i.dueDate} · outstanding {inr(n(i.outstanding))}
                  </span>
                </div>
                {n(i.tdsExpected) > 0 && (
                  <Pill tone="warn">TDS {inr(n(i.tdsExpected))} u/s {i.tdsSection ?? '194J'}</Pill>
                )}
              </div>

              <div className="mt-2.5 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="Amount received">
                  <input inputMode="decimal" value={r.amount} placeholder="0.00"
                    onChange={(e) => set(i.id, { amount: e.target.value })}
                    className={inputClass} style={inputStyle} />
                </Field>
                <Field label="TDS withheld by client">
                  <input inputMode="decimal" value={r.tds} placeholder="0.00"
                    onChange={(e) => set(i.id, { tds: e.target.value })}
                    className={inputClass} style={inputStyle} />
                </Field>
                <Button type="button" variant="ghost" size="sm" onClick={() => settleInFull(i)}>
                  Settle in full
                </Button>
              </div>

              {(n(r.amount) > 0 || n(r.tds) > 0) && (
                <p className="mt-1.5 text-[11.5px]"
                  style={{ color: Math.abs(left) < 0.5 ? 'var(--good)' : left < 0 ? 'var(--critical)' : 'var(--text-muted)' }}>
                  {Math.abs(left) < 0.5
                    ? 'Settles this invoice in full'
                    : left < 0
                      ? `Over-allocated by ${inr(Math.abs(left))}`
                      : `${inr(left)} would remain outstanding`}
                </p>
              )}
            </div>
          )
        })}
      </Card>

      {totalTds > 0 && (
        <Alert tone="info" title={`${inr(totalTds)} of TDS will be booked as receivable`}>
          That is tax the client pays to the government on your behalf. It is only claimable
          once it appears in <strong>Form 26AS</strong> &mdash; recording it here is what puts it on
          the TDS receivable screen to be chased.
        </Alert>
      )}

      {overAllocated.length > 0 && (
        <Alert tone="critical" title="More allocated than is outstanding">
          {overAllocated.map((i) => i.number).join(', ')} would be over-settled. Reduce the
          amount or the TDS.
        </Alert>
      )}

      {state?.error && (
        <p className="rounded-lg px-3 py-2.5 text-[12.5px]"
          style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-[13px]">
          <span style={{ color: 'var(--text-muted)' }}>Cash received </span>
          <strong className="tabular">{inr(totalCash)}</strong>
          {totalTds > 0 && (
            <>
              <span className="ml-3" style={{ color: 'var(--text-muted)' }}>plus TDS </span>
              <strong className="tabular">{inr(totalTds)}</strong>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/receipts"><Button variant="ghost" type="button">Cancel</Button></Link>
          <Button disabled={pending || totalCash + totalTds <= 0 || overAllocated.length > 0}>
            {pending ? 'Recording…' : 'Record receipt'}
          </Button>
        </div>
      </Card>
    </form>
  )
}
