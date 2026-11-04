'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { Card, Button, Field, Alert, inputClass, inputStyle } from '@/components/ui/kit'
import { createDebitNoteAction } from './actions'

export function DebitNoteForm({ invoiceId, invoiceNumber, today, taxMode }: {
  invoiceId: string
  invoiceNumber: string
  today: string
  taxMode: string
}) {
  const [state, action, pending] = useActionState(createDebitNoteAction, null)

  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Card className="space-y-4 p-5">
        <Field label="Additional taxable value"
          hint={taxMode === 'EXPORT'
            ? 'The invoice is a zero-rated export, so this carries no GST either'
            : 'GST follows the rate on the invoice — it is never re-rated here'}>
          <input name="taxableValue" inputMode="decimal" required placeholder="10000"
            className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Date" hint="The tax belongs to the month this note is issued — s.34(4)">
          <input type="date" name="date" required defaultValue={today} className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Reason" hint="Reported in GSTR-1 and read by the client">
          <input name="reason" required minLength={5} className={inputClass} style={inputStyle}
            placeholder="Two extra days of the sprint, agreed on 14 Oct" />
        </Field>

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <Alert tone="info" title="A debit note is not an amendment">
          An amendment corrects what was <strong>reported</strong> about {invoiceNumber}. A debit note charges
          something <strong>further</strong> — the invoice was right for what it covered, and this is extra.
        </Alert>

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending}>{pending ? 'Issuing…' : 'Issue debit note'}</Button>
          <Link href={`/invoices/${invoiceId}`}><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
