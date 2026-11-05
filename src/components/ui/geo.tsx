'use client'
import type { SelectHTMLAttributes } from 'react'
import { COUNTRIES } from '@/lib/countries'
import { STATE_OPTIONS } from '@/lib/indian-states'
import { CURRENCIES } from '@/lib/currencies'
import { inputClass, inputStyle } from './kit'

/**
 * The three lists every party form needs, stated once.
 *
 * Each of these was previously written out as literal <option> tags in the form that
 * happened to need it — five countries here, six there, seven states in one place and
 * twelve in another. A party that was not on somebody's shortlist simply could not be
 * recorded. docs/87.
 */
type Props = SelectHTMLAttributes<HTMLSelectElement>

/** Every ISO country. India is grouped apart because it is the tax fork, not a favourite. */
export function CountrySelect(props: Props) {
  return (
    <select className={inputClass} style={inputStyle} {...props}>
      <optgroup label="Domestic">
        <option value="IN">India</option>
      </optgroup>
      <optgroup label="Overseas — export, zero-rated under LUT">
        {COUNTRIES.filter((c) => c.code !== 'IN').map((c) => (
          <option key={c.code} value={c.code}>{c.name}</option>
        ))}
      </optgroup>
    </select>
  )
}

/** Every GST state code. The code is what decides CGST+SGST versus IGST, so it is shown. */
export function StateSelect(props: Props) {
  return (
    <select className={inputClass} style={inputStyle} {...props}>
      {STATE_OPTIONS.map((s) => (
        <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
      ))}
    </select>
  )
}

/**
 * The billing currency — INR and USD first because that is the real choice, then the rest.
 * Offered only where it is actually honoured: a domestic invoice is INR by law of the
 * ledger, and `invoiceCurrency` ignores this field for anything but an export.
 */
export function CurrencySelect(props: Props) {
  return (
    <select className={inputClass} style={inputStyle} {...props}>
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
      ))}
    </select>
  )
}
