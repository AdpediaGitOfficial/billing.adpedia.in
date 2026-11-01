'use client'
import { useRef, useState, useTransition } from 'react'
import { Pill, tapTarget } from '@/components/ui/kit'
import { confirmCardAction, unconfirmCardAction } from './actions'

export interface PanCardView {
  kind: 'EMPLOYEE' | 'VENDOR'
  id: string
  evidence: 'NONE' | 'DECLARED' | 'CARD_ON_FILE'
  cards: { id: string; filename: string }[]
}

/**
 * Upload the PAN card itself, against one person.
 *
 * 🔴 The card is never previewed, only downloaded — the server refuses to serve anything a
 * user uploaded inline, and an identity document is the last thing that should be rendered
 * in this origin.
 *
 * Confirming is a human act: somebody opens the card, reads the number, and says it matches.
 * The button records who and when. Nothing here reads the image.
 */
export function PanCard({ view }: { view: PanCardView }) {
  const [cards, setCards] = useState(view.cards)
  const [evidence, setEvidence] = useState(view.evidence)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', 'PAN_CARD')
      form.append('entityType', view.kind === 'EMPLOYEE' ? 'Employee' : 'Vendor')
      form.append('entityId', view.id)

      const res = await fetch('/api/attachments', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? 'Could not store that file')
      setCards((c) => [{ id: body.id, filename: body.filename }, ...c.filter((x) => x.id !== body.id)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not store that file')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function confirm() {
    setError(null)
    start(async () => {
      const r = await confirmCardAction(view.kind, view.id)
      if (r.ok) setEvidence('CARD_ON_FILE')
      else setError(r.message)
    })
  }

  function unconfirm() {
    setError(null)
    start(async () => {
      const r = await unconfirmCardAction(view.kind, view.id, 'Withdrawn from the PAN register')
      if (r.ok) setEvidence('DECLARED')
      else setError(r.message)
    })
  }

  const working = busy || pending

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {evidence === 'CARD_ON_FILE'
          ? <Pill tone="good" dot>card confirmed</Pill>
          : cards.length > 0
            ? <Pill tone="warn" dot>card, unconfirmed</Pill>
            : <Pill tone="neutral">no card</Pill>}
      </div>

      {cards.map((c) => (
        <a key={c.id} href={`/api/attachments/${c.id}`}
          className="block truncate text-[11.5px] underline underline-offset-2"
          style={{ color: 'var(--text-secondary)' }}>
          {c.filename}
        </a>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={working}
          className={`text-[11.5px] underline underline-offset-2 ${tapTarget}`}
          style={{ color: 'var(--accent)' }}>
          {busy ? 'Uploading…' : cards.length > 0 ? 'Add another' : 'Upload card'}
        </button>

        {cards.length > 0 && evidence !== 'CARD_ON_FILE' && (
          <button type="button" onClick={confirm} disabled={working}
            className={`text-[11.5px] underline underline-offset-2 ${tapTarget}`} style={{ color: 'var(--good)' }}>
            {pending ? 'Saving…' : 'It matches'}
          </button>
        )}
        {evidence === 'CARD_ON_FILE' && (
          <button type="button" onClick={unconfirm} disabled={working}
            className={`text-[11.5px] underline underline-offset-2 ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>
            Withdraw
          </button>
        )}
      </div>

      {/* 🔴 A PAN card arrives as a phone photo as often as a scan, so HEIC is accepted —
          the server checks the magic bytes whatever the browser claims. */}
      <input ref={fileRef} type="file" className="hidden"
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />

      {error && <p className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{error}</p>}
    </div>
  )
}
