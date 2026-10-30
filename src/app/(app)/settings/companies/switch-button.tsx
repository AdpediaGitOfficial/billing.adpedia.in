'use client'
import { useActionState } from 'react'
import { Button } from '@/components/ui/kit'
import { switchCompanyAction } from './actions'

/** One form per entity, so the id is submitted rather than held in client state. */
export function SwitchButton({ companyId, legalName }: { companyId: string; legalName: string }) {
  const [state, action, pending] = useActionState(switchCompanyAction, null)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <Button size="sm" variant="ghost" disabled={pending}>
        {pending ? 'Switching…' : `Open ${legalName}`}
      </Button>
      {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
    </form>
  )
}
