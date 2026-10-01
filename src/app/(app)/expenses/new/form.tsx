'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { createExpenseAction } from '../actions'
import { Card, Field, Button, Alert, inputClass, inputStyle } from '@/components/ui/kit'

type Category = { id: string; name: string; code: string; itcDefault: string; gstTreatment: string; rcmPossible: boolean }

const REASONS = [
  ['S17_5_B_FOOD', 'Food, beverages, restaurant or catering — s.17(5)(b)'],
  ['S17_5_B_CAB', 'Cab or taxi — passenger transport — s.17(5)(b)'],
  ['NO_REGISTRATION_IN_STATE', 'Hotel GST in a state with no Adpedia registration'],
  ['S17_5_G_PERSONAL', 'Personal consumption — s.17(5)(g)'],
  ['UNREGISTERED_SUPPLIER', 'Supplier is unregistered'],
  ['NO_GSTIN_ON_INVOICE', 'Invoice does not carry Adpedia’s GSTIN'],
]

export function ExpenseForm({ categories, projects }: { categories: Category[]; projects: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createExpenseAction, null)
  const [categoryId, setCategoryId] = useState('')
  const [itcEligible, setItcEligible] = useState(true)

  const category = categories.find((c) => c.id === categoryId)
  const blockedByDefault = category?.itcDefault === 'BLOCKED'
  const partial = category?.itcDefault === 'PARTIAL'

  return (
    <form action={action}>
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <select name="categoryId" required value={categoryId}
              onChange={(e) => { setCategoryId(e.target.value); const c = categories.find((x) => x.id === e.target.value); setItcEligible(c?.itcDefault === 'FULL') }}
              className={inputClass} style={inputStyle}>
              <option value="">Select…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className={inputClass} style={inputStyle} /></Field>
          <div className="sm:col-span-2">
            <Field label="Description"><input name="description" required className={inputClass} style={inputStyle} placeholder="Blue Light Cable Vision — August" /></Field>
          </div>
          <Field label="Amount before GST"><input name="taxableValue" required inputMode="decimal" className={inputClass} style={inputStyle} /></Field>
          <Field label="GST rate">
            <select name="gstRatePct" className={inputClass} style={inputStyle} defaultValue="18">
              <option value="18">18%</option><option value="12">12%</option><option value="5">5%</option><option value="0">None</option>
            </select>
          </Field>
          <Field label="Supply">
            <select name="gstMode" className={inputClass} style={inputStyle} defaultValue="INTRA">
              <option value="INTRA">Within Kerala — CGST + SGST</option>
              <option value="INTER">Other state — IGST</option>
              <option value="NONE">No GST charged</option>
            </select>
          </Field>
          <Field label="Paid from">
            <select name="paidFrom" className={inputClass} style={inputStyle} defaultValue="BANK">
              <option value="BANK">Bank</option><option value="CARD">Card</option><option value="CASH">Cash</option>
              <option value="PERSONAL_REIMBURSABLE">Personal — reimbursable</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Project">
              <select name="projectId" className={inputClass} style={inputStyle}>
                <option value="">None</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
        </div>

        {category && (
          <div className="mt-5 space-y-2.5">
            <label className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" name="itcEligible" checked={itcEligible} onChange={(e) => setItcEligible(e.target.checked)} className="h-4 w-4" />
              Claim input tax credit
            </label>

            {!itcEligible && (
              <Field label="Why the credit is blocked">
                <select name="itcBlockedReason" required className={inputClass} style={inputStyle}>
                  <option value="">Select the clause…</option>
                  {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            )}

            {blockedByDefault && itcEligible && (
              <Alert tone="critical" title="This category normally blocks the credit">
                Claiming it here is a deliberate override. Make sure the clause actually permits it.
              </Alert>
            )}
            {partial && (
              <Alert tone="warn" title="Partly blocked category">
                Travel is mixed: flights, trains and hotels in Kerala are claimable; food, cabs and
                out-of-state hotel GST are not. Split the claim if the bill covers both.
              </Alert>
            )}
            {category.rcmPossible && (
              <Alert tone="info" title="Check who billed you">
                If the supplier has no Indian GSTIN this is an import of service and reverse charge
                applies — record it as a vendor bill rather than an expense so the self-invoice is generated.
              </Alert>
            )}
          </div>
        )}

        {state?.error && (
          <p className="mt-4 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--critical-soft)', color: 'var(--critical)' }}>{state.error}</p>
        )}

        <div className="mt-5 flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save expense'}</Button>
          <Link href="/expenses"><Button variant="ghost" type="button">Cancel</Button></Link>
        </div>
      </Card>
    </form>
  )
}
