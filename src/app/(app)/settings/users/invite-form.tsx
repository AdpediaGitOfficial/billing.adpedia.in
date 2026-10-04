'use client'
import { useActionState, useState } from 'react'
import { Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { inviteUserAction } from './actions'

const ROLES = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR'] as const

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUserAction, null)
  const [copied, setCopied] = useState(false)
  const link = state?.link ? `${typeof window === 'undefined' ? '' : window.location.origin}${state.link}` : null

  return (
    <div className="space-y-4">
      <form action={action} className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" hint="What appears in the audit log beside everything they do">
          <input name="name" required className={inputClass} style={inputStyle} placeholder="Priya Nair" />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required className={inputClass} style={inputStyle} placeholder="priya@example.com" />
        </Field>
        <Field label="Role" hint="Fixed now — they cannot choose it">
          <select name="role" defaultValue="EMPLOYEE" className={inputClass} style={inputStyle}>
            {ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create the invitation'}</Button>
          {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
        </div>
      </form>

      {link && (
        /**
         * 🔴 Shown once. Only the hash of the token is stored, so this link cannot be looked
         * up again — which is the point, and is why it says so rather than letting somebody
         * discover it by coming back tomorrow.
         */
        <Alert tone="good" title={`Send this to ${state!.email} — it will not be shown again`}>
          <p className="mb-2">
            Nothing is emailed from here. Send it the way you would send anything else, the way a chase goes
            out: from you. It is good for seven days and can be used once.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-[11.5px]"
              style={{ background: 'var(--surface-1)', color: 'var(--text-primary)' }}>{link}</code>
            <Button size="sm" variant="ghost" type="button"
              onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true) }}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Alert>
      )}
    </div>
  )
}
