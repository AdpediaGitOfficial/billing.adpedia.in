'use client'
import { useActionState, useState } from 'react'
import { Card, Pill, Button } from '@/components/ui/kit'
import { removePasskeyAction } from './actions'

export interface PasskeyRow {
  id: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
  backedUp: boolean
}

/**
 * The passkeys on this account — docs/49.
 *
 * 🔴 They could be added and never removed. `listPasskeys` and `deletePasskey` have existed
 * since phase 9 with nothing able to call them, and the settings screen showed only a COUNT —
 * so a phone that was lost, sold or left at a previous employer kept a working credential to
 * the company's books, and the only way to revoke it was the database.
 *
 * A passkey is removed on sight of its label, so each one says when it was added, when it was
 * last used, and whether it is synced to a cloud keychain (where revoking it here does not
 * remove it from the other devices sharing that keychain).
 */
export function Passkeys({ rows }: { rows: PasskeyRow[] }) {
  const [state, action, pending] = useActionState(removePasskeyAction, null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const list = state?.ok ? rows.filter((p) => p.id !== state.removedId) : rows

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold">Passkeys</p>
          <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Each one signs in to this account on its own. Remove any that belong to a device you no
            longer have — a passkey left on a lost phone keeps working until it is revoked here.
          </p>
        </div>
        <Pill tone={list.length > 0 ? 'good' : 'neutral'}>{list.length}</Pill>
      </div>

      {list.length === 0 ? (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          No passkeys yet. Add one above to unlock with Face ID or a fingerprint instead of a password.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-[12.5px]"
              style={{ borderColor: 'var(--rule)' }}>
              <div>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{p.label ?? 'Unnamed device'}</span>
                  {p.backedUp && <Pill tone="neutral">synced</Pill>}
                </span>
                <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  added {p.createdAt}
                  {p.lastUsedAt ? ` · last used ${p.lastUsedAt}` : ' · never used'}
                </span>
              </div>

              {confirming === p.id ? (
                <form action={action} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <Button size="sm" variant="ghost" disabled={pending}>
                    {pending ? 'Removing…' : 'Remove it'}
                  </Button>
                  <button type="button" onClick={() => setConfirming(null)}
                    className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>back</button>
                </form>
              ) : (
                <button type="button" onClick={() => setConfirming(p.id)}
                  className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>remove</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 🔴 A synced passkey lives in a cloud keychain, not on one device. Removing it here
          stops it signing in, which is the point — but it is worth saying that the credential
          itself is still on every device sharing that keychain. */}
      {list.some((p) => p.backedUp) && (
        <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          A <strong>synced</strong> passkey is shared through a cloud keychain. Removing it here revokes
          it for this account on every device that holds it.
        </p>
      )}

      {state?.error && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--critical)' }}>{state.error}</p>
      )}
    </Card>
  )
}
