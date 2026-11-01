'use client'
import { useActionState, useState } from 'react'
import type { Role } from '@prisma/client'
import { Button, Pill, inputClass, inputStyle, tapTarget } from '@/components/ui/kit'
import { changeRoleAction, setUserActiveAction } from './actions'

const ROLES: Role[] = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR']
const label = (r: string) => r.replace('_', ' ').toLowerCase()

/**
 * 🔴 The reason is asked for in the same breath as the change, not after it — docs/77.
 *
 * Every other correction in this system demands one before it happens (`ReverseButton`), and
 * for the same reason: the question an auditor asks about a period is who could see what, and
 * from when. A dialog that asks afterwards is one somebody dismisses.
 */
export function MemberControls({ userId, name, role, isActive, isLastOwner, isSelf }: {
  userId: string
  name: string
  role: Role
  isActive: boolean
  isLastOwner: boolean
  isSelf: boolean
}) {
  const [open, setOpen] = useState<'role' | 'access' | null>(null)

  if (isSelf) return <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>you</span>
  if (isLastOwner) {
    return (
      <Pill tone="neutral">
        only active owner
      </Pill>
    )
  }

  if (open === 'role') return <RoleForm userId={userId} name={name} role={role} onDone={() => setOpen(null)} />
  if (open === 'access') return <AccessForm userId={userId} name={name} isActive={isActive} onDone={() => setOpen(null)} />

  return (
    <span className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => setOpen('role')}
        className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>change role</button>
      <button type="button" onClick={() => setOpen('access')}
        className={`text-[11.5px] underline ${tapTarget}`} style={{ color: isActive ? 'var(--critical)' : 'var(--good)' }}>
        {isActive ? 'deactivate' : 'reactivate'}
      </button>
    </span>
  )
}

function RoleForm({ userId, name, role, onDone }: { userId: string; name: string; role: Role; onDone: () => void }) {
  const [state, action, pending] = useActionState(changeRoleAction, null)
  const [next, setNext] = useState<Role>(role)
  const [reason, setReason] = useState('')

  return (
    <form action={action} className="flex w-full flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <select name="role" value={next} onChange={(e) => setNext(e.target.value as Role)}
        className={`${inputClass} w-40`} style={inputStyle}>
        {ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
      </select>
      <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={`Why is ${name} becoming ${label(next)}?`} required minLength={5}
        className={`${inputClass} w-64`} style={inputStyle} />
      <Button size="sm" variant="ghost" disabled={pending || next === role || reason.trim().length < 5}>
        {pending ? 'Saving…' : 'Change it'}
      </Button>
      <button type="button" onClick={onDone} className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>back</button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}

function AccessForm({ userId, name, isActive, onDone }: { userId: string; name: string; isActive: boolean; onDone: () => void }) {
  const [state, action, pending] = useActionState(setUserActiveAction, null)
  const [reason, setReason] = useState('')

  return (
    <form action={action} className="flex w-full flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={isActive ? '' : '1'} />
      <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={isActive ? `Why is ${name} being removed?` : `Why is ${name} coming back?`}
        required minLength={5} className={`${inputClass} w-72`} style={inputStyle} />
      <Button size="sm" variant={isActive ? 'danger' : 'ghost'} disabled={pending || reason.trim().length < 5}>
        {pending ? 'Saving…' : isActive ? 'Deactivate' : 'Reactivate'}
      </Button>
      <button type="button" onClick={onDone} className={`text-[11.5px] underline ${tapTarget}`} style={{ color: 'var(--text-muted)' }}>back</button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}
