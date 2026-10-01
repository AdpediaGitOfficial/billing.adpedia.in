'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approvePayrollAction, paySalariesAction } from '../actions'
import { Card, Button } from '@/components/ui/kit'
import type { PayrollStatus } from '@prisma/client'

export function RunActions({ month, year, runId, status, label }: {
  month: number; year: number; runId: string | null; status: PayrollStatus | null; label: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.ok) router.refresh(); else setError(r.error ?? 'Something went wrong')
    })
  }

  if (status === 'PAID') {
    return <Card><p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{label} payroll is approved and paid.</p></Card>
  }

  return (
    <Card>
      {status === 'APPROVED' && runId ? (
        <>
          <Button onClick={() => run(() => paySalariesAction(runId, new Date().toISOString().slice(0, 10)))} disabled={pending}>
            {pending ? 'Recording…' : 'Record salary payment'}
          </Button>
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            The TDS and profession tax withheld stay as liabilities until the challan is paid — they are not part of this transfer.
          </p>
        </>
      ) : (
        <>
          <Button onClick={() => run(() => approvePayrollAction(month, year))} disabled={pending}>
            {pending ? 'Approving…' : `Approve ${label} payroll`}
          </Button>
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            Approving posts the salary cost split by project allocation, records the s.192
            deductions for Form 24Q, and creates the payslips. All of it is permanent.
          </p>
        </>
      )}
      {error && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{error}</p>}
    </Card>
  )
}
