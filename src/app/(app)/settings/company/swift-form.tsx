'use client'
import { useActionState } from 'react'
import { setBankSwiftAction } from './actions'
import { Button, inputClass, inputStyle } from '@/components/ui/kit'

/**
 * 🔴 The one bank field an overseas client cannot pay without, and the only one on the
 * invoice template that nothing could fill — docs/87.
 */
export function SwiftForm({ bankAccountId, swift }: { bankAccountId: string; swift: string }) {
  const [state, action, pending] = useActionState(setBankSwiftAction, null)

  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input name="swift" defaultValue={swift} placeholder="AXISINBB046" maxLength={11}
        autoCapitalize="characters" spellCheck={false} aria-label="SWIFT code"
        className={`${inputClass} uppercase w-[11.5ch] text-center tabular`} style={inputStyle} />
      <Button size="sm" variant="ghost" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      {state?.error && (
        <p className="w-full text-right text-[11.5px]" style={{ color: 'var(--critical)' }}>{state.error}</p>
      )}
      {state?.ok && (
        <p className="w-full text-right text-[11.5px]" style={{ color: 'var(--good)' }}>{state.ok}</p>
      )}
    </form>
  )
}
