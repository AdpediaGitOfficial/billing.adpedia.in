'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/kit'
import { rebookInvoiceAction } from '../../actions'

/** docs/92 — the second step: the figures were shown, this posts them. */
export function ConfirmRebook({ invoiceId, fxRate, date, backHref }: {
  invoiceId: string; fxRate: string; date: string; backHref: string
}) {
  const [state, action, pending] = useActionState(rebookInvoiceAction.bind(null, invoiceId), null)
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="fxRate" value={fxRate} />
      <input type="hidden" name="date" value={date} />
      {state?.error && (
        <p className="rounded-lg px-3 py-2.5 text-[12.5px]" style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending}>{pending ? 'Posting…' : 'Post the correction'}</Button>
        <Link href={backHref}><Button variant="ghost" type="button">Cancel</Button></Link>
      </div>
    </form>
  )
}
