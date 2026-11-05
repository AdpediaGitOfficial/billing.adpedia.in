import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COUNTRIES, countryName, isKnownCountry } from '@/lib/countries'
import { STATE_NAMES, STATE_OPTIONS, stateName } from '@/lib/indian-states'
import { CURRENCIES, currencyName, currencyWords } from '@/lib/currencies'
import { stateName as stateNameFromTaxMode } from '@/server/services/tax/tax-mode'
import { printableAddress } from '@/server/services/sales/customer'

/**
 * 🔴 docs/87 — three lists that existed only as <option> tags.
 *
 * Countries were written out five at a time in three forms (and six in a fourth, already
 * drifted), the GST state table was copied in partial seven- and twelve-entry slices into
 * four more, and the currency a client is billed in had a database column, a comment saying
 * it is agreed with the client, and no writer at all.
 */

describe('countries', () => {
  it('is the whole ISO list, not somebody’s shortlist', () => {
    expect(COUNTRIES.length).toBeGreaterThan(240)
  })

  it('holds the ones this company actually bills, which the old lists did not', () => {
    for (const code of ['CN', 'MY', 'TH', 'AU', 'NZ', 'AE', 'US', 'GB', 'SG', 'IE', 'IN']) {
      expect(isKnownCountry(code)).toBe(true)
    }
  })

  it('has no duplicate code', () => {
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length)
  })

  it('every code is two upper-case letters — the e-invoice CntCode is validated on length', () => {
    for (const c of COUNTRIES) expect(c.code).toMatch(/^[A-Z]{2}$/)
  })

  it('names a code, and falls back to whatever an old record stored', () => {
    expect(countryName('AE')).toBe('United Arab Emirates')
    expect(countryName('cn')).toBe('China')
    // an invoice issued before this table existed snapshotted the name, not the code
    expect(countryName('United States')).toBe('United States')
    expect(countryName(null)).toBe('')
  })
})

describe('Indian states', () => {
  it('is the full GST table, not the dozen somebody listed', () => {
    expect(STATE_OPTIONS.length).toBe(36)
    for (const code of ['08', '03', '23', '21', '18', '38']) {
      expect(STATE_NAMES[code]).toBeTruthy()   // Rajasthan, Punjab, MP, Odisha, Assam, Ladakh
    }
  })

  it('leaves 96 and 97 out of what a form offers — they are GSTR-1 buckets, not places', () => {
    expect(STATE_NAMES['96']).toBe('Other Country')
    expect(STATE_OPTIONS.find((s) => s.code === '96')).toBeUndefined()
    expect(STATE_OPTIONS.find((s) => s.code === '97')).toBeUndefined()
  })

  it('is the same table `tax-mode` has always exported', () => {
    expect(stateNameFromTaxMode('32')).toBe(stateName('32'))
    expect(stateNameFromTaxMode('32')).toBe('Kerala')
  })
})

describe('currencies', () => {
  it('can say what an invoice is denominated in', () => {
    expect(currencyName('USD')).toBe('US Dollar')
    expect(currencyWords('INR')).toBe('Indian Rupees')
  })

  it('🔴 says the right thing for the currencies that used to print “US Dollars”', () => {
    expect(currencyWords('AED')).toBe('UAE Dirhams')
    expect(currencyWords('GBP')).toBe('Pounds Sterling')
    expect(currencyWords('SGD')).toBe('Singapore Dollars')
    expect(currencyWords('CNY')).toBe('Chinese Yuan')
  })

  it('falls back to the bare code rather than refusing an unlisted one', () => {
    expect(currencyWords('ZMW')).toBe('ZMW')
    expect(currencyName('')).toBe('')
  })

  it('offers INR and USD first — the choice that is actually made', () => {
    expect(CURRENCIES[0].code).toBe('INR')
    expect(CURRENCIES[1].code).toBe('USD')
  })
})

describe('the billing address, which prints on the invoice', () => {
  it('🔴 carries the country NAME, not the code — found by rendering a Dubai invoice', () => {
    expect(printableAddress({ line1: 'Office 1204', city: 'Dubai', country: 'AE' }, 'AE').country)
      .toBe('United Arab Emirates')
  })

  it('falls back to the customer’s country when the address does not carry one', () => {
    expect(printableAddress({ city: 'Shanghai' }, 'CN').country).toBe('China')
  })

  it('leaves a name already written there alone', () => {
    expect(printableAddress({ country: 'India' }, 'IN').country).toBe('India')
  })

  it('keeps the rest of the address untouched', () => {
    expect(printableAddress({ line1: 'A', city: 'B', pincode: '680683' }, 'IN'))
      .toEqual({ line1: 'A', city: 'B', pincode: '680683', country: 'India' })
  })
})

// ── the sweep ────────────────────────────────────────────────────────────────

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

// the three tables, and the one component allowed to turn them into <option> tags
const LIST_FILES = [
  join('lib', 'countries.ts'), join('lib', 'indian-states.ts'), join('lib', 'currencies.ts'),
  join('components', 'ui', 'geo.tsx'),
]

describe('🔴 no form writes out its own list again', () => {
  const sources = files('src').filter((p) => !LIST_FILES.some((f) => p.endsWith(f)))
  const read = (p: string) => readFileSync(p, 'utf8')

  it('sees the code it is sweeping', () => {
    // 🔴 a clean sweep means nothing unless the sweep can find the thing it is looking for
    expect(sources.length).toBeGreaterThan(200)
    const users = sources.filter((p) => /CountrySelect|StateSelect|CurrencySelect/.test(read(p)))
    expect(users.length).toBeGreaterThanOrEqual(5)
  })

  it('no hand-written country option', () => {
    const offenders = sources.filter((p) => /<option value="(IN|US|GB|AE|SG)">/.test(read(p)))
    expect(offenders).toEqual([])
  })

  it('no hand-written state table', () => {
    // the shape every one of the four copies had: ['32', 'Kerala']
    const offenders = sources.filter((p) => /\[\s*'\d\d'\s*,\s*'[A-Z]/.test(read(p)))
    expect(offenders).toEqual([])
  })

  it('🔴 nothing decides the amount-in-words currency with a ternary on INR', () => {
    const offenders = sources.filter((p) => /===\s*'INR'\s*\?\s*'Indian Rupees'/.test(read(p)))
    expect(offenders).toEqual([])
  })
})
