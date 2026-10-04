'use client'
import { useActionState, useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { createInvoiceAction } from '../actions'
import { Card, Field, Button, Pill, inputClass, inputStyle } from '@/components/ui/kit'

type Customer = { id: string; name: string; country: string; stateCode: string | null; defaultTdsSection: string | null }
type Project = { id: string; name: string; customerId: string }
type Item = { id: string; name: string; sacCode: string | null; defaultRate: string | null }
/**
 * 🔴 `serviceItemId` — docs/67.
 *
 * The catalogue was loaded into this form and used only as a datalist: picking a service
 * copied its SAC and rate and threw away WHICH service it was. So no invoice line has ever
 * carried a `serviceItemId`, the income account on every one of the ten seeded services was
 * never consulted, and every rupee of revenue posted to the fallback 4010 — leaving the
 * revenue sub-accounts in the chart (4030 Design, 4040 Film & Video Production) permanently
 * empty and the P&L's revenue section a single line.
 */
type Line = { description: string; sacCode: string; quantity: string; rate: string; gstRatePct: string; serviceItemId?: string | null }

interface Preview {
  taxMode: string; placeOfSupplyLabel: string; currency: string; requiresLut: boolean; nextNumber: string | null
  sacIssues?: { line: number; description: string; level: 'error' | 'warn'; message: string }[]
  totals: { taxableValue: string; cgst: string; sgst: string; igst: string; roundOff: string; grandTotal: string }
  tds: { section: string | null; tdsAmount: string; netPayable: string }
}

const blank = (): Line => ({ description: '', sacCode: '', quantity: '1', rate: '', gstRatePct: '18', serviceItemId: null })
const inr = (v: string) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(Number(v))

export function InvoiceForm({ customers, projects, items }: { customers: Customer[]; projects: Project[]; items: Item[] }) {
  const [state, action, pending] = useActionState(createInvoiceAction, null)
  const [customerId, setCustomerId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [tdsSection, setTdsSection] = useState('')
  const [lines, setLines] = useState<Line[]>([blank()])
  const [preview, setPreview] = useState<Preview | null>(null)

  const customer = customers.find((c) => c.id === customerId)
  const customerProjects = projects.filter((p) => p.customerId === customerId)

  // adopt the customer's usual TDS section when one is picked
  useEffect(() => { if (customer) setTdsSection(customer.defaultTdsSection ?? '') }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!customerId || !lines.some((l) => l.rate)) { setPreview(null); return }
    const res = await fetch('/api/invoices/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId, date, tdsSection: tdsSection || null, lines }),
    })
    setPreview(res.ok ? await res.json() : null)
  }, [customerId, date, tdsSection, lines])

  useEffect(() => { const t = setTimeout(refresh, 250); return () => clearTimeout(t) }, [refresh])

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <form action={action}>
      <input type="hidden" name="lines" value={JSON.stringify(lines.filter((l) => l.description && l.rate))} />
      <input type="hidden" name="tdsSection" value={tdsSection} />

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer">
            <select name="customerId" required value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClass} style={inputStyle}>
              <option value="">Select…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>

          <Field label="Project">
            <select name="projectId" className={inputClass} style={inputStyle} disabled={!customerId}>
              <option value="">None</option>
              {customerProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>

          <Field label="Invoice date">
            <input name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} style={inputStyle} />
          </Field>

          <Field label="Your reference / PO">
            <input name="customerRef" className={inputClass} style={inputStyle} />
          </Field>
        </div>

        {preview && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md px-3 py-2.5" style={{ background: 'var(--color-brand-50)' }}>
            <Pill>{preview.taxMode === 'INTRA' ? 'Intra-state · CGST + SGST'
              : preview.taxMode === 'INTER' ? 'Inter-state · IGST'
              : 'Export · zero-rated'}</Pill>
            <span className="text-[11.5px]" style={{ color: 'var(--color-brand-700)' }}>
              Place of supply {preview.placeOfSupplyLabel} · next number {preview.nextNumber}
            </span>
            {preview.requiresLut && <Pill tone="critical">Needs a LUT for this FY</Pill>}
          </div>
        )}

        {/* 🔴 Shown BEFORE the invoice is numbered. A wrong SAC is cheap to change now and
            expensive once it has been sent and reported in the GSTR-1 HSN summary. */}
        {preview?.sacIssues && preview.sacIssues.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {preview.sacIssues.map((i, n) => (
              <li key={n} className="rounded-md px-3 py-2 text-[11.5px] leading-relaxed"
                style={{
                  background: 'var(--surface)',
                  color: i.level === 'error' ? 'var(--critical)' : 'var(--text-muted)',
                }}>
                <strong>Line {i.line}</strong> — {i.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4 p-5">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>Line items</p>

        <div className="grid gap-3">
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-12">
              <div className="sm:col-span-5">
                <input list="svc" value={l.description} placeholder="Description of service"
                  onChange={(e) => {
                    const match = items.find((it) => it.name === e.target.value)
                    // 🔴 cleared when the text no longer matches. A line edited away from a
                    // service while keeping its id would post revenue to that service's
                    // account for work it is no longer describing.
                    setLine(i, {
                      description: e.target.value,
                      serviceItemId: match?.id ?? null,
                      ...(match ? { sacCode: match.sacCode ?? '', rate: match.defaultRate ?? l.rate } : {}),
                    })
                  }}
                  className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-2">
                <input value={l.sacCode} onChange={(e) => setLine(i, { sacCode: e.target.value })}
                  placeholder="SAC" inputMode="numeric" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-1">
                <input value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })}
                  inputMode="decimal" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-3">
                <input value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })}
                  placeholder="Rate" inputMode="decimal" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-1 flex items-center">
                {lines.length > 1 && (
                  <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="w-full rounded-md py-2 text-[12px]" style={{ color: '#B4231F' }}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <datalist id="svc">{items.map((i) => <option key={i.id} value={i.name} />)}</datalist>

        <button type="button" onClick={() => setLines((ls) => [...ls, blank()])}
          className="mt-3 text-[13px] font-semibold" style={{ color: 'var(--accent)' }}>+ Add line</button>
      </Card>

      <Card className="mt-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="TDS the customer will deduct" hint="On the taxable value, excluding GST">
            <select value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} className={inputClass} style={inputStyle}>
              <option value="">No TDS</option>
              <option value="194J">194J — 10%</option>
              <option value="194C">194C — 2%</option>
            </select>
          </Field>
          <Field label="Milestone"><input name="milestone" className={inputClass} style={inputStyle} placeholder="3 of 4" /></Field>
        </div>

        {preview && (
          <dl className="mt-5 ml-auto max-w-xs text-[13.5px]">
            <Row k="Taxable value" v={inr(preview.totals.taxableValue)} />
            {preview.taxMode === 'INTRA' && <><Row k="CGST 9%" v={inr(preview.totals.cgst)} /><Row k="SGST 9%" v={inr(preview.totals.sgst)} /></>}
            {preview.taxMode === 'INTER' && <Row k="IGST 18%" v={inr(preview.totals.igst)} />}
            {preview.taxMode === 'EXPORT' && <Row k="GST — zero rated" v="0.00" />}
            {preview.totals.roundOff !== '0.00' && <Row k="Round off" v={inr(preview.totals.roundOff)} />}
            <Row k="Invoice total" v={inr(preview.totals.grandTotal)} strong />
            {preview.tds.section && (
              <>
                <Row k={`Less TDS u/s ${preview.tds.section}`} v={`(${inr(preview.tds.tdsAmount)})`} />
                <Row k="Net payable" v={inr(preview.tds.netPayable)} strong />
              </>
            )}
          </dl>
        )}

        {state?.error && (
          <p className="mt-4 rounded-md px-3 py-2 text-[12.5px]" style={{ background: '#FFF1F0', color: '#B4231F' }}>{state.error}</p>
        )}

        <div className="mt-5 flex gap-2">
          <Button type="submit" disabled={pending || !preview}>{pending ? 'Saving…' : 'Save as draft'}</Button>
          <Link href="/invoices"><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
        <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          Saving creates a draft. The invoice number is allocated when you send it.
        </p>
      </Card>
    </form>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? 'border-t font-semibold' : ''}`} style={strong ? { borderColor: 'var(--rule)' } : undefined}>
      <dt style={{ color: strong ? undefined : 'var(--text-muted)' }}>{k}</dt>
      <dd className="tabular">{v}</dd>
    </div>
  )
}
