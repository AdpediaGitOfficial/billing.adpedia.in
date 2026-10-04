'use client'
import { useActionState, useState } from 'react'
import { Button, Field, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { recordRocDatesAction } from './actions'

export interface RocYear {
  id: string
  label: string
  agmLimit: string
  agmHeldOn: string
  agmSource: string
  aoc4FiledOn: string
  mgt7FiledOn: string
}

/**
 * The registrar's dates — docs/72.
 *
 * 🔴 The AOC-4 and MGT-7 deadlines are shown live, derived from the AGM date in the field
 * beside them, because that is the relationship somebody gets wrong: the forms run from the
 * meeting that was HELD, not from 30 September.
 */
export function RocForm({ year }: { year: RocYear }) {
  const [state, action, pending] = useActionState(recordRocDatesAction, null)
  /**
   * 🔴 Derived from the field, not from what was saved.
   *
   * The deadlines were rendered from the stored AGM date first, so typing a new one left the
   * hints showing the old form dates until Save — which is precisely the moment the
   * relationship needs to be visible, because the whole point is that moving the meeting moves
   * both filings with it.
   */
  const [agm, setAgm] = useState(year.agmHeldOn)
  const plus = (days: number) => {
    if (!agm) return null
    const d = new Date(agm)
    if (Number.isNaN(d.getTime())) return null
    return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10)
  }
  const aoc4By = plus(30)
  const mgt7By = plus(60)
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="financialYearId" value={year.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="AGM held on" hint={`s.96 — by ${year.agmLimit} for FY ${year.label}`}>
          <input name="agmHeldOn" type="date" value={agm} onChange={(e) => setAgm(e.target.value)}
            className={inputClass} style={inputStyle} />
        </Field>
        <Field label="Where the date came from" hint="The minutes, the company secretary, the portal">
          <input name="agmSource" defaultValue={year.agmSource} className={inputClass} style={inputStyle}
            placeholder="Minutes of the meeting, signed" />
        </Field>
        <Field label="AOC-4 filed on"
          hint={aoc4By ? `s.137(1) — 30 days from the meeting, so by ${aoc4By}` : 'Thirty days from the AGM; record the meeting first'}>
          <input name="aoc4FiledOn" type="date" defaultValue={year.aoc4FiledOn} className={inputClass} style={inputStyle} />
        </Field>
        <Field label="MGT-7 filed on"
          hint={mgt7By ? `s.92(4) — 60 days from the meeting, so by ${mgt7By}` : 'Sixty days from the AGM; record the meeting first'}>
          <input name="mgt7FiledOn" type="date" defaultValue={year.mgt7FiledOn} className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
        {!agm && <Pill tone="warn">no meeting on record</Pill>}
        {state?.error && <span className="text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</span>}
        {state?.ok && <span className="text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</span>}
      </div>
    </form>
  )
}
