'use client'
import { useActionState, useState } from 'react'
import { Card, Button, Pill, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { recordChaseAction } from './actions'

export interface ChaseView {
  kind: string
  subjectId: string
  partyName: string
  email: string | null
  phone: string | null
  why: string
  subject: string
  body: string
  lastAskedAt: string | null
  amount: string | null
}

const LABEL: Record<string, string> = {
  PAN_NUMBER: 'PAN missing',
  PAN_CARD: 'No copy of the card',
  FORM_16A: 'Certificate not sent',
  TDS_CREDIT: 'Credit not in 26AS',
  INVOICE_OVERDUE: 'Payment overdue',
}

const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * One thing to ask one party for, with the words already written.
 *
 * 🔴 Nothing here sends anything. The mail client is the person's own, and so is the name on
 * the message — a chase from `noreply@` is ignored and one from the owner gets a reply.
 * Recording that it went is a separate, deliberate act, because opening a composer is not
 * sending and half of them are closed again.
 */
export function ChaseCard({ chase }: { chase: ChaseView }) {
  const [state, action, pending] = useActionState(recordChaseAction, null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const mailto = chase.email
    ? `mailto:${encodeURIComponent(chase.email)}?subject=${encodeURIComponent(chase.subject)}&body=${encodeURIComponent(chase.body)}`
    : null
  const whatsapp = chase.phone
    ? `https://wa.me/${chase.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(`${chase.subject}\n\n${chase.body}`)}`
    : null

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${chase.subject}\n\n${chase.body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the text is on screen to select */ }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
            {chase.partyName}
            <Pill tone={chase.kind === 'PAN_NUMBER' || chase.kind === 'TDS_CREDIT' ? 'critical' : 'warn'}>
              {LABEL[chase.kind] ?? chase.kind}
            </Pill>
          </p>
          <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>{chase.why}</p>
        </div>
        {chase.amount && <span className="shrink-0 text-[14px] font-semibold tabular">{inr(chase.amount)}</span>}
      </div>

      <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        {chase.lastAskedAt
          ? `Last asked ${chase.lastAskedAt}`
          : 'Never asked'}
        {!chase.email && !chase.phone && ' · no email or phone on their record, so there is nowhere to send it'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mailto && <a href={mailto}><Button size="sm" variant="ghost" icon="Mail">Email</Button></a>}
        {whatsapp && (
          <a href={whatsapp} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost" icon="MessageCircle">WhatsApp</Button>
          </a>
        )}
        <Button size="sm" variant="ghost" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy text'}</Button>
        <button type="button" onClick={() => setOpen(!open)}
          className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
          {open ? 'hide' : 'read it first'}
        </button>
      </div>

      {open && (
        <pre className="mt-3 whitespace-pre-wrap rounded-lg px-3 py-2.5 font-sans text-[12px] leading-relaxed"
          style={{ background: 'var(--surface)', color: 'var(--text-secondary)' }}>
{chase.subject}

{chase.body}
        </pre>
      )}

      <form action={action} className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3" style={{ borderColor: 'var(--rule)' }}>
        <input type="hidden" name="kind" value={chase.kind} />
        <input type="hidden" name="subjectId" value={chase.subjectId} />
        <input type="hidden" name="partyName" value={chase.partyName} />
        <input type="hidden" name="message" value={`${chase.subject}\n\n${chase.body}`} />
        <Field label="Sent to">
          <input name="sentTo" required minLength={3} defaultValue={chase.email ?? chase.phone ?? ''}
            placeholder="address, number, or how" className={inputClass} style={inputStyle} />
        </Field>
        <Field label="How">
          <select name="channel" className={inputClass} style={inputStyle} defaultValue={chase.email ? 'EMAIL' : 'WHATSAPP'}>
            <option value="EMAIL">Email</option>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="PHONE">Phone</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
        <Button size="sm" disabled={pending}>{pending ? 'Saving…' : 'I sent this'}</Button>
      </form>

      {state?.error && <p className="mt-2 text-[12px]" style={{ color: 'var(--critical)' }}>{state.error}</p>}
      {state?.ok && <p className="mt-2 text-[12px]" style={{ color: 'var(--good)' }}>{state.ok}</p>}
    </Card>
  )
}
