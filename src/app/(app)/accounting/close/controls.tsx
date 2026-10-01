'use client'
import { useActionState, useState } from 'react'
import { Card, Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { lockAction, unlockAction, closeAction, reopenAction, createNextFyAction } from './actions'

export function CloseControls({ fyId, fyLabel, status, lockedUpTo, startsOn, endsOn, canClose, needsNextFy }: {
  fyId: string; fyLabel: string; status: string
  lockedUpTo: string | null; startsOn: string; endsOn: string; canClose: boolean
  needsNextFy?: boolean
}) {
  const [lockState, lock, locking] = useActionState(lockAction, null)
  const [unlockState, unlock, unlocking] = useActionState(unlockAction, null)
  const [closeState, close, closing] = useActionState(closeAction, null)
  const [reopenState, reopen, reopening] = useActionState(reopenAction, null)
  const [nextFyState, nextFy, creatingFy] = useActionState(createNextFyAction, null)

  // 🔴 Closing is typed out in full, not clicked. It is a once-a-year action that locks the
  // whole year, and an accidental click during a scroll is exactly the mistake to design out.
  const [confirm, setConfirm] = useState('')
  const [reopenConfirm, setReopenConfirm] = useState('')
  const phrase = `CLOSE ${fyLabel}`

  return (
    <div className="space-y-4">
      {needsNextFy && (
        <Card className="space-y-2 p-4">
          <p className="text-[14px] font-semibold">Open the next financial year first</p>
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            A closed year needs somewhere for corrections to go. This also copies the document
            numbering series across with the sequence reset to 1 &mdash; without it, the first
            invoice of the new year would have no number to draw.
          </p>
          <form action={nextFy}>
            <Button variant="ghost" disabled={creatingFy}>
              {creatingFy ? 'Opening…' : 'Open the next year'}
            </Button>
          </form>
          <Msg state={nextFyState} />
        </Card>
      )}

      {status === 'OPEN' && (
        <Card className="space-y-3 p-4">
          <p className="text-[14px] font-semibold">Lock a period</p>
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Nothing dated on or before this can be posted or changed.
            {lockedUpTo && <> Currently locked to <strong>{lockedUpTo}</strong>.</>}
          </p>
          <form action={lock} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="fyId" value={fyId} />
            <Field label="Lock up to and including">
              <input type="date" name="upTo" min={startsOn} max={endsOn} required
                className={inputClass} style={inputStyle} />
            </Field>
            <Button disabled={locking}>{locking ? 'Locking…' : 'Lock'}</Button>
          </form>
          <Msg state={lockState} />

          {lockedUpTo && (
            <details>
              <summary className="cursor-pointer text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                Reopen the locked period
              </summary>
              <form action={unlock} className="mt-2 space-y-2">
                <input type="hidden" name="fyId" value={fyId} />
                <Field label="Why" hint="Goes into the audit log. At least 10 characters.">
                  <input name="reason" required minLength={10}
                    placeholder="CA found an unrecorded expense for May"
                    className={inputClass} style={inputStyle} />
                </Field>
                <Button variant="ghost" disabled={unlocking}>
                  {unlocking ? 'Unlocking…' : 'Unlock'}
                </Button>
              </form>
              <Msg state={unlockState} />
            </details>
          )}
        </Card>
      )}

      {status === 'OPEN' ? (
        <Card className="space-y-3 p-4">
          <p className="text-[14px] font-semibold">Close FY {fyLabel}</p>
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            {canClose
              ? 'Every blocking check has passed. Type the phrase to confirm.'
              : 'Blocked — clear the checks above first.'}
          </p>
          <form action={close} className="space-y-2">
            <input type="hidden" name="fyId" value={fyId} />
            <Field label={`Type ${phrase} to confirm`}>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                placeholder={phrase} autoCapitalize="characters" spellCheck={false}
                className={inputClass} style={inputStyle} disabled={!canClose} />
            </Field>
            <Button disabled={!canClose || confirm.trim().toUpperCase() !== phrase || closing}>
              {closing ? 'Closing…' : `Close FY ${fyLabel}`}
            </Button>
          </form>
          <Msg state={closeState} />
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <p className="text-[14px] font-semibold">FY {fyLabel} is closed</p>
          <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Reopening <strong>reverses</strong> the closing entry rather than deleting it, so the
            journal keeps both and an auditor can see exactly what happened.
          </p>
          <form action={reopen} className="space-y-2">
            <input type="hidden" name="fyId" value={fyId} />
            <Field label="Why" hint="Goes into the audit log. At least 10 characters.">
              <input name="reason" required minLength={10}
                value={reopenConfirm} onChange={(e) => setReopenConfirm(e.target.value)}
                placeholder="CA found an unrecorded expense for March"
                className={inputClass} style={inputStyle} />
            </Field>
            <Button variant="ghost" disabled={reopenConfirm.trim().length < 10 || reopening}>
              {reopening ? 'Reopening…' : 'Reopen the year'}
            </Button>
          </form>
          <Msg state={reopenState} />
        </Card>
      )}
    </div>
  )
}

function Msg({ state }: { state: { error?: string; ok?: string } | null }) {
  if (!state) return null
  return (
    <p className="rounded-lg px-3 py-2 text-[12.5px]"
      style={{ background: 'var(--surface)', color: state.error ? 'var(--critical)' : 'var(--good)' }}>
      {state.error ?? state.ok}
    </p>
  )
}
