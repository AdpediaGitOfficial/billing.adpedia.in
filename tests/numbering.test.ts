import { describe, it, expect } from 'vitest'
import { renderPattern, validatePattern, validateInvoiceNumber } from '@/server/services/invoicing/numbering'

/**
 * 🔴 docs/83 §6 — the shape of a company's own invoice numbers.
 *
 * `DocumentSeries.pattern` was stored, rendered, checked against rule 46 and printed on the
 * settings page, and nothing in the application could set it. These are the rules that decide
 * which patterns a person may choose, so they are rules about rule 46 and about a unique
 * index — not about taste.
 */
describe('🔴 a number pattern a series may be set to', () => {
  it('takes the sequence wherever the business puts it', () => {
    expect(renderPattern('ADP/{FY}/{SEQ:4}', { FY: '26-27', SEQ: 30 })).toBe('ADP/26-27/0030')
    expect(renderPattern('{SEQ}/ADP/{FY}', { FY: '26-27', SEQ: 30 })).toBe('30/ADP/26-27')
    expect(renderPattern('{SEQ:3}/ADP/{FY}', { FY: '26-27', SEQ: 8 })).toBe('008/ADP/26-27')
    expect(validatePattern('{SEQ}/ADP/{FY}')).toEqual({ ok: true })
  })

  /**
   * 🔴 Not a style rule. `@@unique([companyId, number])` is the index behind it: a pattern
   * with no sequence renders the same string for every document in the year, and the second
   * send fails at the end of a transaction that has already posted a ledger entry.
   */
  it('refuses one with no sequence in it', () => {
    const v = validatePattern('ADP/{FY}')
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toMatch(/\{SEQ\}/)
  })

  /**
   * 🔴 The same index, from the other side: it is unique per COMPANY, not per financial year,
   * and the sequence restarts each April. Without {FY}, invoice 1 of 2027-28 collides with
   * invoice 1 of 2026-27 — and the collision surfaces in April, on the first invoice of a new
   * year, which is the worst possible moment to discover it.
   */
  it('refuses one with no financial year in it', () => {
    const v = validatePattern('ADP/{SEQ:4}')
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toMatch(/\{FY\}/)
  })

  it('holds the literal text to rule 46(b)’s own alphabet', () => {
    expect(validatePattern('ADP #{SEQ}/{FY}').ok).toBe(false)
    expect(validatePattern('ADP_{SEQ}/{FY}').ok).toBe(false)
    expect(validatePattern('ADP-{SEQ}/{FY}')).toEqual({ ok: true })
  })

  it('refuses a placeholder it does not know, rather than printing it', () => {
    const v = validatePattern('{PREFIX}/{SEQ}/{FY}')
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toMatch(/only placeholders/)
  })

  it('is not vacuous — a pattern can still be too long once it is rendered', () => {
    // validatePattern checks the SHAPE; the length is rule 46's and belongs to the number
    expect(validatePattern('ADPEDIAFILMS/{SEQ:4}/{FY}')).toEqual({ ok: true })
    const widest = renderPattern('ADPEDIAFILMS/{SEQ:4}/{FY}', { FY: '26-27', SEQ: 9999 })
    expect(validateInvoiceNumber(widest).ok).toBe(false)
  })
})
