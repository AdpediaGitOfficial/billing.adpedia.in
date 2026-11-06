'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveBillAction, payBillAction, cancelBillAction } from '../actions'
import { Card, Button, inputClass, inputStyle } from '@/components/ui/kit'
import type { BillStatus } from '@prisma/client'
import { useLiveRate } from '@/components/fx/use-live-rate'
import { showRate } from '@/lib/fx'

export function BillActions({ billId, status, owed, currency = 'INR' }: { billId: string; status: BillStatus; owed: string; currency?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState(owed)
  const [reference, setReference] = useState('')
  // docs/93 — a foreign bill is paid in its own currency and leaves the bank in rupees
  const [inrPaid, setInrPaid] = useState('')
  const { live } = useLiveRate(currency, '')   // docs/94 — a sanity figure only; the bank's debit is what is typed

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
            <>
            <div className={`mt-3 grid gap-2 ${currency !== 'INR' ? 'sm:grid-cols-2' : 'sm:grid-cols-[1fr_1fr_auto]'}`}>
              <label className="grid gap-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {currency !== 'INR' ? `Amount paid (${currency})` : 'Amount paid'}
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputClass} style={inputStyle} />
              </label>
              {currency !== 'INR' && (
                <label className="grid gap-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  Rupees that left the bank
                  <input value={inrPaid} onChange={(e) => setInrPaid(e.target.value)} inputMode="decimal" placeholder="e.g. 9,414.00" className={inputClass} style={inputStyle} />
                </label>
              )}
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / reference" className={inputClass} style={inputStyle} />
              <Button onClick={() => run(() => payBillAction(billId, amount, new Date().toISOString().slice(0, 10), reference || undefined, inrPaid || undefined))}
                disabled={pending || (currency !== 'INR' && !(Number(inrPaid) > 0))}>
                Pay
              </Button>
            </div>
            {currency !== 'INR' && live && live.exact && Number(amount) > 0 && (
              <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                About ₹{(Number(amount) * Number(live.rate)).toLocaleString('en-IN', { maximumFractionDigits: 2 })} at the live rate of ₹{showRate(live.rate)} ({live.source}, {live.asOf}) — type what the bank actually debited.
              </p>
            )}
            {currency !== 'INR' && (
              <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                The difference from the rupees this bill was booked at is a realised forex gain or loss — a card&rsquo;s own markup lands there too.
              </p>
            )}
            </>
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
