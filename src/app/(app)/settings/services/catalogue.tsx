'use client'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, Button, Field, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { saveServiceItemAction, retireServiceItemAction } from './actions'

export interface ServiceView {
  id: string
  name: string
  sacCode: string | null
  sacTitle: string | null
  defaultRate: string | null
  gstRatePct: string
  incomeAccountId: string | null
  incomeAccountLabel: string | null
  isActive: boolean
  usedOn: number
  issues: string[]
}

export interface AccountOption { id: string; label: string }

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The service catalogue — docs/67.
 *
 * 🔴 A service is RETIRED, never deleted. An invoice line points at it, and a filed invoice's
 * line has to keep pointing at something — the same rule the whole system follows. Retiring
 * it stops it being offered on a new invoice and leaves every old one intact.
 */
export function Catalogue({ rows, accounts }: { rows: ServiceView[]; accounts: AccountOption[] }) {
  const router = useRouter()
  const [state, action, pending] = useActionState(saveServiceItemAction, null)
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  async function retire(id: string, isActive: boolean) {
    setBusy(true)
    await retireServiceItemAction(id, isActive)
    setBusy(false)
    router.refresh()
  }

  const form = (r?: ServiceView) => (
    <form action={action} className="space-y-3 rounded-lg p-3" style={{ background: 'var(--surface)' }}>
      {r && <input type="hidden" name="id" value={r.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="what prints on the invoice line">
          <input name="name" required minLength={2} defaultValue={r?.name}
            placeholder="Staff augmentation" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="SAC code" hint="six digits beginning 99">
          <input name="sacCode" defaultValue={r?.sacCode ?? ''} placeholder="998314"
            className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Default rate" hint="optional — a starting point, not a fixed price">
          <input name="defaultRate" inputMode="decimal" defaultValue={r?.defaultRate ?? ''}
            className={inputClass} style={inputStyle} />
        </Field>
        <Field label="GST rate %">
          <select name="gstRatePct" defaultValue={r?.gstRatePct ?? '18.00'} className={inputClass} style={inputStyle}>
            {['0', '5', '12', '18', '28'].map((v) => (
              <option key={v} value={v}>{v}%</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Revenue posts to" hint="income accounts only — anything else would leave the P&L short">
        <select name="incomeAccountId" defaultValue={r?.incomeAccountId ?? ''} className={inputClass} style={inputStyle}>
          <option value="">4010 Sales — the default</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending}>{pending ? 'Saving…' : r ? 'Save' : 'Add it'}</Button>
        <button type="button" onClick={() => { setEditing(null); setAdding(false) }}
          className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>cancel</button>
      </div>
    </form>
  )

  return (
    <Card flush className="overflow-hidden">
      <CardHeader title="Services" className="p-5 pb-3"
        sub="The catalogue every invoice line starts from"
        action={!adding && (
          <Button size="sm" variant="ghost" icon="Plus" onClick={() => { setAdding(true); setEditing(null) }}>
            Add a service
          </Button>
        )} />

      <div className="space-y-2 px-5 pb-4">
        {adding && form()}

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
        )}
        {state?.ok && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>{state.ok}</p>
        )}

        {rows.map((r) => (
          <div key={r.id} className="border-t pt-2" style={{ borderColor: 'var(--rule)' }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold"
                  style={r.isActive ? undefined : { color: 'var(--text-muted)' }}>
                  {r.name}
                  {!r.isActive && <Pill tone="neutral">retired</Pill>}
                  <Pill tone="neutral">{r.gstRatePct.replace(/\.00$/, '')}% GST</Pill>
                </p>
                <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {r.sacCode ? `SAC ${r.sacCode}${r.sacTitle ? ` · ${r.sacTitle}` : ''}` : 'no SAC code'}
                  {r.defaultRate && ` · ${inr(r.defaultRate)}`}
                  {' · '}{r.incomeAccountLabel ?? '4010 Sales (default)'}
                  {r.usedOn > 0 && ` · on ${r.usedOn} invoice line${r.usedOn === 1 ? '' : 's'}`}
                </p>
                {r.issues.map((i) => (
                  <p key={i} className="mt-0.5 text-[11.5px]" style={{ color: 'var(--warn)' }}>{i}</p>
                ))}
              </div>
              <span className="flex shrink-0 items-center gap-3">
                <button type="button" onClick={() => { setEditing(editing === r.id ? null : r.id); setAdding(false) }}
                  className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
                  {editing === r.id ? 'close' : 'edit'}
                </button>
                <button type="button" disabled={busy} onClick={() => void retire(r.id, !r.isActive)}
                  className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
                  {r.isActive ? 'retire' : 'bring back'}
                </button>
              </span>
            </div>
            {editing === r.id && <div className="mt-2">{form(r)}</div>}
          </div>
        ))}

        {rows.length === 0 && !adding && (
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Nothing in the catalogue. An invoice line can still be typed by hand — a service here just saves
            doing it again, and keeps the SAC consistent across invoices, which is what GSTR-1 reports.
          </p>
        )}
      </div>
    </Card>
  )
}
