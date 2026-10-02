'use client'
import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, inputClass, inputStyle } from '@/components/ui/kit'

export type ReverseState = { error?: string; ok?: string } | null
export type ReverseAction = (prev: ReverseState, form: FormData) => Promise<ReverseState>

/**
 * The button behind every correction — docs/49.
 *
 * 🔴 Cancelling posts a REVERSING entry. It is not an edit and not a delete, so the reason is
 * required: it is the only record of why the figures moved, and it is what somebody reads
 * when they ask that question a year later.
 *
 * One component, because the four corrections in docs/40 are the same act on different
 * documents — and the one that shipped with a button was quietly the only one anybody could
 * perform. Three near-identical copies would have been three places for that to drift.
 */
export function ReverseButton({
  action, idName, id, label = 'cancel', prompt, confirmLabel = 'Confirm', busyLabel = 'Reversing…',
}: {
  action: ReverseAction
  /** the form field the server action reads the id from */
  idName: string
  id: string
  label?: string
  /** what is being reversed, in words — it goes in the placeholder so the question is specific */
  prompt: string
  confirmLabel?: string
  busyLabel?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [state, formAction, pending] = useActionState(action, null)

  // 🔴 Refresh the page the reversal changed. Without it the row stays on screen exactly as
  // it was — a cancelled payment still offering to be cancelled, a bank line still listed as
  // matched — and the next click is against something that is no longer there.
  useEffect(() => {
    if (state?.ok) router.refresh()
  }, [state?.ok, router])

  if (state?.ok) {
    return <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
        {label}
      </button>
    )
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name={idName} value={id} />
      <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={prompt} required minLength={5}
        className={`${inputClass} w-64`} style={inputStyle} />
      {/* 🔴 Five characters, checked here and again in the service. "ok" is not a reason. */}
      <Button size="sm" variant="ghost" disabled={pending || reason.trim().length < 5}>
        {pending ? busyLabel : confirmLabel}
      </Button>
      <button type="button" onClick={() => setOpen(false)}
        className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>back</button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}
