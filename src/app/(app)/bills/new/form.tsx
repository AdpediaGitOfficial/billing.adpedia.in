'use client'
import { useActionState, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createBillAction } from '../actions'
import { Card, Field, Button, Alert, Pill, inputClass, inputStyle } from '@/components/ui/kit'

type Vendor = { id: string; name: string; country: string; gstin: string | null; pan: string | null; panVerified: boolean; rcmApplicable: boolean; defaultTdsSection: string | null }
type Line = { description: string; sacCode: string; quantity: string; rate: string; gstRatePct: string; expenseAccountCode: string }

interface Preview {
  taxableValue: string; cgst: string; sgst: string; igst: string; grandTotal: string
  rcmIgst: string; netPayable: string; itcEligible: boolean; warnings: string[]
  tds: { applies: boolean; section: string | null; ratePct: string; applyOn: string; amount: string; reason: string; cumulativeBefore: string; cumulativeAfter: string }
}

const blank = (): Line => ({ description: '', sacCode: '', quantity: '1', rate: '', gstRatePct: '18', expenseAccountCode: '5210' })
const inr = (v: string) => '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(Number(v))

export function BillForm({ vendors, projects, accounts }: {
  vendors: Vendor[]; projects: { id: string; name: string }[]; accounts: { code: string; name: string }[]
}) {
  const [state, action, pending] = useActionState(createBillAction, null)
  const [vendorId, setVendorId] = useState('')
  const [billDate, setBillDate] = useState(new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<Line[]>([blank()])
  const [preview, setPreview] = useState<Preview | null>(null)

  const vendor = vendors.find((v) => v.id === vendorId)

  const refresh = useCallback(async () => {
    if (!vendorId || !lines.some((l) => l.rate)) { setPreview(null); return }
    const res = await fetch('/api/bills/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendorId, billDate, billNumber: 'PREVIEW', lines }),
    })
    setPreview(res.ok ? await res.json() : null)
  }, [vendorId, billDate, lines])

  useEffect(() => { const t = setTimeout(refresh, 250); return () => clearTimeout(t) }, [refresh])

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <form action={action}>
      <input type="hidden" name="lines" value={JSON.stringify(lines.filter((l) => l.description && l.rate))} />

      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor">
            <select name="vendorId" required value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={inputClass} style={inputStyle}>
              <option value="">Select…</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          <Field label="Project">
            <select name="projectId" className={inputClass} style={inputStyle}>
              <option value="">None</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Vendor's bill number" hint="As printed on their invoice">
            <input name="billNumber" required className={inputClass} style={inputStyle} placeholder="EX/2026/114" />
          </Field>
          <Field label="Bill date">
            <input name="billDate" type="date" required value={billDate} onChange={(e) => setBillDate(e.target.value)} className={inputClass} style={inputStyle} />
          </Field>
        </div>

        {vendor && (
          <div className="mt-4 flex flex-wrap gap-2">
            {vendor.rcmApplicable && <Pill tone="warn" dot>Reverse charge</Pill>}
            {vendor.defaultTdsSection && <Pill tone="accent">TDS {vendor.defaultTdsSection}</Pill>}
            {!vendor.panVerified && vendor.defaultTdsSection && <Pill tone="critical" dot>No PAN — 20%</Pill>}
            {vendor.gstin && <Pill tone="neutral">{vendor.gstin}</Pill>}
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <p className="eyebrow mb-3">Line items</p>
        <div className="grid gap-3">
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-3">
                <select value={l.expenseAccountCode} onChange={(e) => setLine(i, { expenseAccountCode: e.target.value })} className={inputClass} style={inputStyle}>
                  {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <input value={l.sacCode} onChange={(e) => setLine(i, { sacCode: e.target.value })} placeholder="SAC" inputMode="numeric" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-2">
                <input value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} placeholder="Amount" inputMode="decimal" className={inputClass} style={inputStyle} />
              </div>
              <div className="sm:col-span-1 flex items-center">
                {lines.length > 1 && (
                  <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="w-full rounded-md py-2 text-[12px]" style={{ color: 'var(--critical)' }}>×</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setLines((ls) => [...ls, blank()])}
          className="mt-3 text-[13px] font-semibold" style={{ color: 'var(--accent)' }}>+ Add line</button>
      </Card>

      {preview && (
        <>
          {preview.warnings.length > 0 && (
            <div className="mt-4 space-y-2.5">
              {preview.warnings.map((w) => (
                <Alert key={w} tone={w.includes('206AA') || w.includes('crossing') || w.includes('not just this bill') ? 'critical' : 'warn'}
                  title={w.includes('reverse charge') ? 'Reverse charge applies'
                    : w.includes('206AA') ? 'No PAN on file'
                    : w.includes('not just this bill') ? 'Annual threshold crossed'
                    : w.includes('headroom') ? 'Close to the annual threshold'
                    : w.includes('15CA') ? 'Non-resident payment'
                    : 'Check before approving'}>
                  {w}
                </Alert>
              ))}
            </div>
          )}

          <Card className="mt-4">
            <dl className="ml-auto max-w-sm text-[13.5px]">
              <Row k="Taxable value" v={inr(preview.taxableValue)} />
              {Number(preview.cgst) > 0 && <><Row k="CGST" v={inr(preview.cgst)} /><Row k="SGST" v={inr(preview.sgst)} /></>}
              {Number(preview.igst) > 0 && <Row k="IGST" v={inr(preview.igst)} />}
              <Row k="Bill total" v={inr(preview.grandTotal)} strong />
              {Number(preview.rcmIgst) > 0 && (
                <Row k="IGST under reverse charge (cash)" v={inr(preview.rcmIgst)} tone="warn" />
              )}
              {preview.tds.applies && (
                <>
                  <Row k={`Less TDS u/s ${preview.tds.section} @ ${preview.tds.ratePct}%`} v={`(${inr(preview.tds.amount)})`} tone="warn" />
                  {preview.tds.applyOn !== preview.taxableValue && (
                    <p className="py-1 text-[11.5px]" style={{ color: 'var(--warn)' }}>
                      Charged on {inr(preview.tds.applyOn)} — the vendor&rsquo;s whole year, not this bill alone.
                    </p>
                  )}
                </>
              )}
              <Row k="Payable to the vendor" v={inr(preview.netPayable)} strong />
            </dl>
            {!preview.tds.applies && preview.tds.reason && (
              <p className="mt-3 text-right text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{preview.tds.reason}</p>
            )}
          </Card>
        </>
      )}

      <Card className="mt-4">
        {state?.error && (
          <p className="mb-4 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || !preview}>{pending ? 'Saving…' : 'Save as draft'}</Button>
          <Link href="/bills"><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
        <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          Nothing posts to the ledger until the bill is approved.
        </p>
      </Card>
    </form>
  )
}

function Row({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'warn' }) {
  return (
    <div className={`flex justify-between gap-4 py-1 ${strong ? 'border-t font-semibold' : ''}`} style={strong ? { borderColor: 'var(--rule)' } : undefined}>
      <dt style={{ color: tone === 'warn' ? 'var(--warn)' : strong ? undefined : 'var(--text-secondary)' }}>{k}</dt>
      <dd className="tabular" style={{ color: tone === 'warn' ? 'var(--warn)' : undefined }}>{v}</dd>
    </div>
  )
}
