'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { Card, Button, Field, inputClass, inputStyle, Empty } from '@/components/ui/kit'
import { createProjectAction } from '../actions'

export function ProjectForm({ customers }: { customers: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createProjectAction, null)

  if (customers.length === 0) {
    return (
      <Card>
        <Empty icon="Users" title="Add a client first"
          hint="Every project belongs to a client — that is what makes client P&L possible."
          action={<Link href="/customers/new"><Button>New client</Button></Link>} />
      </Card>
    )
  }

  return (
    <form action={action}>
      <Card className="space-y-4 p-5">
        <Field label="Client">
          <select name="customerId" required className={inputClass} style={inputStyle}>
            <option value="">Choose…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <Field label="Project name">
          <input name="name" required placeholder="Prime — Website Development"
            className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Short code" hint="Appears on every project report. Letters, digits and hyphens.">
          <input name="code" required placeholder="PRIME-WEB" maxLength={24}
            autoCapitalize="characters" spellCheck={false}
            className={`${inputClass} uppercase`} style={inputStyle} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contract value" hint="Optional — drives the billed-against-contract bar">
            <input name="contractValue" inputMode="decimal" placeholder="800000"
              className={inputClass} style={inputStyle} />
          </Field>
          <Field label="Starts on" hint="Optional">
            <input name="startsOn" type="date" className={inputClass} style={inputStyle} />
          </Field>
        </div>

        {state?.error && (
          <p className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <div className="flex gap-2">
          <Button disabled={pending}>{pending ? 'Creating…' : 'Create project'}</Button>
          <Link href="/projects"><Button variant="ghost">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
