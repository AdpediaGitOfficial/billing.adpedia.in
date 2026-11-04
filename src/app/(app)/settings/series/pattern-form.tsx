'use client'
import { useActionState, useState } from 'react'
import { Button, Field, inputClass, inputStyle } from '@/components/ui/kit'
import { setSeriesPatternAction } from './actions'

/**
 * Set the shape of a series' numbers — docs/83 §6.
 *
 * 🔴 The preview is derived from the FIELD, not from what is saved, for the same reason the
 * ROC form's deadlines are (docs/72): the one thing a person needs to see while typing a
 * pattern is the string it will actually print, and rendering the stored one shows them the
 * format they are trying to leave.
 *
 * It renders the sequence the series is really on, so what is on screen is the next number
 * this company will issue and not a sample.
 */
export function PatternForm({ docType, pattern, nextSeq, fyShort }: {
  docType: string; pattern: string; nextSeq: number; fyShort: string
}) {
  const [state, action, pending] = useActionState(setSeriesPatternAction, null)
  const [draft, setDraft] = useState(pattern)

  const render = (seq: number) => draft
    .replace('{FY}', fyShort)
    .replace(/\{SEQ(?::(\d+))?\}/, (_m, pad?: string) =>
      pad ? String(seq).padStart(Number(pad), '0') : String(seq))

  const preview = render(nextSeq)
  /**
   * 🔴 Rule 46(b) is checked at the WIDEST the pattern will reach this year, not at the next
   * number — the same rule the server applies and docs/64's register applies.
   *
   * The first version counted `preview`, so a pattern that fits at 30 and breaches sixteen
   * characters at 9999 read as 12 of 16 in muted grey and was then refused on submit. A hint
   * that disagrees with the rule is worse than no hint.
   */
  const widest = render(9999)
  const tooLong = widest.length > 16
  const missing = [!/\{SEQ(?::\d+)?\}/.test(draft) && '{SEQ}', !draft.includes('{FY}') && '{FY}']
    .filter(Boolean) as string[]

  return (
    <form action={action} className="border-t px-5 py-4" style={{ borderColor: 'var(--rule)' }}>
      <input type="hidden" name="docType" value={docType} />
      <Field label="Number pattern"
        hint="{FY} is the short financial year, {SEQ} the sequence — {SEQ:4} pads it to four digits.">
        <input name="pattern" value={draft} onChange={(e) => setDraft(e.target.value)}
          className={inputClass} style={inputStyle} spellCheck={false} />
      </Field>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
        <span style={{ color: 'var(--text-muted)' }}>Next number</span>
        <span className="tabular font-semibold">{preview}</span>
        <span style={{ color: tooLong ? 'var(--critical)' : 'var(--text-muted)' }}>
          {widest.length} of 16 characters{tooLong ? ` at ${widest}` : ''}
        </span>
      </div>
      {missing.length > 0 && (
        <p className="mt-1 text-[11.5px]" style={{ color: 'var(--critical)' }}>
          {missing.join(' and ')} {missing.length > 1 ? 'are' : 'is'} required.
        </p>
      )}

      {state?.error && <p className="mt-2 text-[12px]" style={{ color: 'var(--critical)' }}>{state.error}</p>}
      {state?.ok && <p className="mt-2 text-[12px]" style={{ color: 'var(--good)' }}>{state.ok}</p>}

      <div className="mt-3">
        <Button type="submit" variant="ghost" disabled={pending || missing.length > 0 || tooLong}>
          {pending ? 'Saving…' : 'Change the pattern'}
        </Button>
      </div>
    </form>
  )
}
