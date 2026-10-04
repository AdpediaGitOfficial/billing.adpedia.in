'use client'
import { useActionState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { acceptInvitationAction } from './actions'

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitationAction, null)
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field label="Choose a password" hint="At least 12 characters. It is hashed with argon2id and never stored as you typed it.">
        <input name="password" type="password" required minLength={12} autoComplete="new-password"
          className={inputClass} style={inputStyle} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? 'Setting it…' : 'Set my password'}</Button>
      {state?.error && (
        <p className="rounded-md px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>
          {state.error}
        </p>
      )}
    </form>
  )
}
