'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { sendInvoiceAction, cancelInvoiceAction } from '../actions'
import { Card, Button } from '@/components/ui/kit'
import type { InvoiceStatus } from '@prisma/client'

export function InvoiceActions({ invoiceId, status, canSend, blockedReason }: {
  invoiceId: string; status: InvoiceStatus; canSend: boolean; blockedReason?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')

  if (status === 'CANCELLED') return null

  function send() {
    setError(null)
    start(async () => {
      const r = await sendInvoiceAction(invoiceId)
      if (r.ok) router.refresh()
      else setError(r.error)
    })
  }

  function cancel() {
    setError(null)
    start(async () => {
      const r = await cancelInvoiceAction(invoiceId, reason)
      if (r.ok) { setCancelling(false); router.refresh() }
      else setError(r.error)
    })
  }

  return (
    <Card className="mt-4 p-4">
      {status === 'DRAFT' ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={send} disabled={pending || !canSend}>
              {pending ? 'Sending…' : 'Send invoice'}
            </Button>
            <Button variant="ghost" onClick={() => setCancelling((v) => !v)} disabled={pending}>Cancel invoice</Button>
          </div>
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {blockedReason
              ? `Blocked — ${blockedReason}.`
              : 'Sending allocates the invoice number and posts the ledger entry. Both are permanent.'}
          </p>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => setCancelling((v) => !v)} disabled={pending}>Cancel invoice</Button>
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            Cancelling keeps the number and posts a reversal — a GST series may not have unexplained gaps.
          </p>
        </>
      )}

      {cancelling && (
        <div className="mt-3 flex gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for cancelling"
            className="flex-1 rounded-md border px-3 py-2 text-[13px]" style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)' }} />
          <Button variant="danger" onClick={cancel} disabled={pending || reason.trim().length < 3}>Confirm</Button>
        </div>
      )}

      {error && <p className="mt-3 rounded-md px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{error}</p>}
    </Card>
  )
}
