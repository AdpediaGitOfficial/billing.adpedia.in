import { describe, it, expect } from 'vitest'
import { parsePortalLedger, parsePortalChallans } from '@/server/services/tax/portal-reconciliation'
import { oltasCin } from '@/server/services/tax/tds-challan'

describe('reading a portal ledger statement', () => {
  it('reads one head and one balance to a line', () => {
    const { heads, skipped } = parsePortalLedger(`
Head,Balance
Integrated Tax,12000.00
Central Tax,3400.00
State/UT Tax,3400.00
Interest,0.00
`)
    expect(skipped).toEqual([])
    expect(Object.fromEntries(heads.map((h) => [h.head, h.balance.toFixed(2)]))).toEqual({
      igst: '12000.00', cgst: '3400.00', sgst: '3400.00', other: '0.00',
    })
  })

  it('takes the LAST amount on the line, because the portal prints credited, debited, balance', () => {
    const { heads } = parsePortalLedger('Integrated Tax,50000.00,38000.00,12000.00')
    expect(heads[0].balance.toFixed(2)).toBe('12000.00')
  })

  it('🔴 refuses a line naming more than one head rather than assigning it to the first', () => {
    // every head contains the word "Tax" — a loose match silently gives the whole
    // statement to IGST, and the reconciliation then passes while the books are out
    const { heads, skipped } = parsePortalLedger('Integrated Tax,Central Tax,State/UT Tax,4')
    expect(heads).toEqual([])
    expect(skipped[0].reason).toMatch(/More than one major head/)
  })

  it('reads the portal closing row positionally, in column order', () => {
    const { heads } = parsePortalLedger('Balance as on 30-09-2026,12000.00,3400.00,3400.00,0.00')
    expect(heads.map((h) => h.head)).toEqual(['igst', 'cgst', 'sgst', 'other'])
    expect(heads[1].balance.toFixed(2)).toBe('3400.00')
  })

  it('reports what it cannot read instead of dropping it', () => {
    const { heads, skipped } = parsePortalLedger('Some row,1234.00,99')
    expect(heads).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  it('keeps the raw line against every figure it read', () => {
    const { heads } = parsePortalLedger('CGST,3400.00')
    expect(heads[0].raw).toBe('CGST,3400.00')
  })
})

describe('reading a challan statement', () => {
  it('🔴 matches the CIN before the BSR code, which lives inside it', () => {
    // an OLTAS CIN begins with the 7-digit BSR code; looking for the BSR first finds it
    // inside the CIN, and then looks for a serial inside the date
    const { rows } = parsePortalChallans('1,05103080709202602001,07-09-2026,118000.00')
    expect(rows).toHaveLength(1)
    expect(rows[0].cin).toBe('05103080709202602001')
    expect(rows[0].bsrCode).toBe('0510308')
  })

  it('reads a 20-character OLTAS CIN into its parts', () => {
    const { rows } = parsePortalChallans('05103080709202602001,200000.00')
    expect(rows[0].bsrCode).toBe('0510308')
    expect(rows[0].challanSerial).toBe('2001')
    expect(rows[0].depositedOn?.toISOString().slice(0, 10)).toBe('2026-09-07')
  })

  it('accepts a longer bank reference in the CIN column', () => {
    const { rows } = parsePortalChallans('1,IDIB000M00126102412345,24-10-2026,9000.00')
    expect(rows[0].cin).toBe('IDIB000M00126102412345')
    expect(rows[0].amount.toFixed(2)).toBe('9000.00')
  })

  it('takes the largest amount on the line as the challan total', () => {
    const { rows } = parsePortalChallans('0510308,02001,07-09-2026,18000.00,500.00,18500.00')
    expect(rows[0].amount.toFixed(2)).toBe('18500.00')
  })

  it('🔴 does not read the challan serial as money', () => {
    // `02001` is a number and looks exactly like ₹2,001 — the line has no amount at all
    const { rows, skipped } = parsePortalChallans('0510308,02001,07-09-2026')
    expect(rows).toEqual([])
    expect(skipped[0].reason).toMatch(/No amount/)
  })

  it('prefers a decimal figure over a bare number for the amount', () => {
    const { rows } = parsePortalChallans('2,0510308,02001,07-09-2026,18000.00')
    expect(rows[0].amount.toFixed(2)).toBe('18000.00')
    expect(rows[0].challanSerial).toBe('02001')
  })

  it('reports a row with references and no amount', () => {
    const { rows, skipped } = parsePortalChallans('0510308,02001,07-09-2026')
    expect(rows).toEqual([])
    expect(skipped[0].reason).toMatch(/No amount/)
  })

  it('ignores a header row quietly and reports a data row with no references', () => {
    const r = parsePortalChallans('CIN,BSR,Date,Amount\nsomething,else,here,1200.00')
    expect(r.rows).toEqual([])
    expect(r.skipped[0].reason).toMatch(/No CIN and no BSR/)
  })
})

describe('🔴 the CIN this system builds', () => {
  it('is BSR + DDMMYYYY + serial, not YYYYMMDD', () => {
    const cin = oltasCin('0510308', new Date(Date.UTC(2026, 8, 7)), '2001')
    expect(cin).toBe('05103080709202602001')
    expect(cin).toHaveLength(20)
    // the shape that was shipped until docs/56 — right length, wrong number
    expect(cin).not.toBe('0510308' + '20260907' + '02001')
  })

  it('pads the serial to five digits', () => {
    expect(oltasCin('0510308', new Date(Date.UTC(2026, 3, 1)), '7')).toBe('05103080104202600007')
  })
})
