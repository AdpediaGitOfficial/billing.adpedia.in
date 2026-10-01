'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveBillAction, payBillAction, cancelBillAction } from '../actions'
import { Card, Button, inputClass, inputStyle } from '@/components/ui/kit'
import type { BillStatus } from '@prisma/client'

export function BillActions({ billId, status, owed }: { billId: string; status: BillStatus; owed: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState(owed)
  const [reference, setReference] = useState('')

  if (status === 'CANCELLED' || status === 'PAID') return null

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.ok) { setPaying(false); router.refresh() } else setError(r.error ?? 'Something went wrong')
    })
  }

  return (
    <Card>
      {status === 'DRAFT' ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run(() => approveBillAction(billId))} disabled={pending}>
              {pending ? 'Approving…' : 'Approve and post'}
            </Button>
            <Button variant="ghost" disabled={pending}
              onClick={() => run(() => cancelBillAction(billId, 'Cancelled from the bill screen'))}>
              Cancel bill
            </Button>
          </div>
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            Approving posts the bill, deducts the TDS and — for a foreign supplier — generates the
            reverse-charge self-invoice. All three are permanent.
          </p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setPaying((v) => !v)} disabled={pending}>Record payment</Button>
            <Button variant="ghost" disabled={pending}
              onClick={() => run(() => cancelBillAction(billId, 'Cancelled from the bill screen'))}>
              Cancel bill
            </Button>
          </div>
          {paying && (
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputClass} style={inputStyle} />
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / reference" className={inputClass} style={inputStyle} />
              <Button onClick={() => run(() => payBillAction(billId, amount, new Date().toISOString().slice(0, 10), reference || undefined))} disabled={pending}>
                Pay
              </Button>
            </div>
          )}
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            The TDS withheld is paid to the government with the monthly challan, not to the vendor.
          </p>
        </>
      )}
      {error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{error}</p>}
    </Card>
  )
}
