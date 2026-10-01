'use client'
import { useActionState } from 'react'
import { Button } from '@/components/ui/kit'
import { approveBillAction } from './actions'

/**
 * Approving posts to the ledger, books TDS and makes the input credit claimable — so the
 * failure path matters as much as the success one. A refusal from the TDS resolver (a
 * threshold crossed retrospectively, a missing PAN) is shown in full rather than reduced
 * to "could not approve": the message IS the decision the person has to make.
 */
export function ApproveButton({ billId, number }: { billId: string; number: string }) {
  const [state, action, pending] = useActionState(approveBillAction, null)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="billId" value={billId} />
      <Button size="sm" disabled={pending}>{pending ? 'Approving…' : `Approve ${number}`}</Button>
      {state?.error && (
        <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>
      )}
      {state?.ok && (
        <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>Approved and posted</span>
      )}
    </form>
  )
}
