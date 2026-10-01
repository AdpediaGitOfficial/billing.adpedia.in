'use client'
import { useActionState, useState } from 'react'
import { Card, Button, Pill, inputClass, inputStyle } from '@/components/ui/kit'
import { savePanForm, pastePans } from './actions'
import { PanCard, type PanCardView } from './pan-card'

export interface PanRow {
  kind: 'EMPLOYEE' | 'VENDOR'
  id: string
  name: string
  pan: string | null
  section: string | null
  verified: boolean
  effective: string
  correct: string
  paid: string
  excess: string
  issues: string[]
  /** paperwork still to collect — not a fault, and styled differently */
  chases: string[]
  /** docs/47 — the card on file, and whether anyone has confirmed it */
  card: PanCardView
}

export function PanForms({ rows }: { rows: PanRow[] }) {
  const [mode, setMode] = useState<'type' | 'paste'>('type')
  const [typeState, typeAction, typePending] = useActionState(savePanForm, null)
  const [pasteState, pasteAction, pastePending] = useActionState(pastePans, null)

  const employees = rows.filter((r) => r.kind === 'EMPLOYEE')
  const vendors = rows.filter((r) => r.kind === 'VENDOR')
  const state = mode === 'type' ? typeState : pasteState

  return (
    <>
      <div className="flex gap-1.5 rounded-lg border p-1" style={{ borderColor: 'var(--rule)' }}>
        <Tab active={mode === 'type'} onClick={() => setMode('type')}>Type them in</Tab>
        <Tab active={mode === 'paste'} onClick={() => setMode('paste')}>Paste a list</Tab>
      </div>

      {state && (
        <p className="rounded-lg px-3 py-2.5 text-[12.5px]"
          style={{ background: 'var(--surface)', color: state.ok ? 'var(--good)' : 'var(--critical)' }}>
          {state.message}
        </p>
      )}

      {mode === 'paste' ? (
        <Card className="p-4">
          <form action={pasteAction}>
            <p className="text-[13px] font-medium">Paste from a spreadsheet or a message</p>
            <p className="mt-1 mb-2.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              One per line, name and PAN in either order. Commas, tabs and pipes all work.
              Names are matched loosely, so &ldquo;Kiran N.S.&rdquo; finds &ldquo;Kiran N S&rdquo;.
              Anything that matches nobody is reported rather than guessed at.
            </p>
            <textarea name="paste" rows={7} className={inputClass} style={inputStyle}
              placeholder={'Akash Raveendran, ABCPE1234F\nDeepak Damodaran\tBXYPK5678L\nKiran N.S. | ...'} />
            <Button className="mt-3" disabled={pastePending}>
              {pastePending ? 'Matching…' : 'Match and save'}
            </Button>
          </form>
        </Card>
      ) : (
        <form action={typeAction} className="space-y-4">
          {employees.length > 0 && <Group title="Employees — s.192" rows={employees} />}
          {vendors.length > 0 && <Group title="Vendors, freelancers and contractors" rows={vendors} />}
          {rows.length === 0 && (
            <Card className="p-4">
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                No employees or vendors on file yet.
              </p>
            </Card>
          )}
          {rows.length > 0 && (
            <Button disabled={typePending}>{typePending ? 'Saving…' : 'Save PANs'}</Button>
          )}
        </form>
      )}
    </>
  )
}

function Group({ title, rows }: { title: string; rows: PanRow[] }) {
  return (
    <Card flush className="overflow-hidden">
      <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
        <span className="eyebrow">{title}</span>
      </div>
      <table className="w-full text-[13px]">
        <tbody>
          {/* 🔴 Rows stack on a phone. With the card column added, three cells sharing 375px
              left the PAN box 60px wide — too narrow to type ten characters into, which is
              the one thing this screen exists for. */}
          {rows.map((r) => (
            <tr key={r.id} className="flex flex-col border-t align-top sm:table-row" style={{ borderColor: 'var(--rule)' }}>
              <td className="px-4 pt-3 sm:py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {!r.pan
                    ? <Pill tone="critical">missing</Pill>
                    : r.issues.length > 0 ? <Pill tone="warn">check</Pill> : <Pill tone="good">on file</Pill>}
                  {r.section && <Pill tone="neutral">s.{r.section}</Pill>}
                </div>

                {!r.pan && r.effective !== '0' && r.correct !== r.effective && (
                  <p className="mt-1 text-[11.5px]" style={{ color: 'var(--critical)' }}>
                    Deducting {r.effective}% instead of {r.correct}%
                    {Number(r.excess) > 0 && <> — ₹{Number(r.excess).toLocaleString('en-IN')} over-withheld so far</>}
                  </p>
                )}

                {r.issues.map((i, n) => (
                  <p key={n} className="mt-1 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>{i}</p>
                ))}
                {r.chases.map((c, n) => (
                  <p key={`c${n}`} className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{c}</p>
                ))}
              </td>
              <td className="px-4 py-2 sm:w-[180px] sm:py-3">
                <input
                  name={`pan:${r.kind}:${r.id}`}
                  defaultValue={r.pan ?? ''}
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={`${inputClass} tabular uppercase`}
                  style={inputStyle}
                />
              </td>
              {/* 🔴 Outside the form on purpose. The file goes straight to the upload
                  endpoint, so attaching a card never risks submitting half-typed PANs in
                  the row above it. */}
              <td className="px-4 pb-3 sm:w-[150px] sm:py-3">
                <PanCard view={r.card} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-md px-3 py-1 text-[13px] font-medium"
      style={active ? { background: 'var(--accent)', color: '#fff' } : { color: 'var(--text-muted)' }}>
      {children}
    </button>
  )
}
