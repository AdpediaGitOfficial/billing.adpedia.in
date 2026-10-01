import { describe, it, expect } from 'vitest'
import { parse26as } from '@/server/services/tax/form26as'

describe('Form 26AS parsing', () => {
  it('reads a CSV export', () => {
    const csv = `
Sr. No.,Name of Deductor,TAN of Deductor,Section,Transaction Date,Status of Booking,Amount Paid/Credited,Tax Deducted
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,30-Sep-2026,F,85000.00,8500.00
2,NUVE PROPERTIES PVT LTD,MUMN54321B,194C,15-Aug-2026,F,200000.00,4000.00
`.trim()
    const r = parse26as(csv)
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toMatchObject({ deductorTan: 'TVDC12345E', sectionCode: '194J', quarter: 2, statusOfBooking: 'F' })
    expect(r.rows[0].tdsDeducted.toFixed(2)).toBe('8500.00')
    expect(r.rows[0].amountPaid.toFixed(2)).toBe('85000.00')
    expect(r.rows[1].quarter).toBe(2)     // August is Q2 of the financial year
    expect(r.totalTds.toFixed(2)).toBe('12500.00')
  })

  it('reads the caret-delimited portal text export', () => {
    const txt = `1^CLICK AR BUSINESS PRIVATE LIMITED^TVDC12345E^194J^30-Sep-2026^F^85000.00^8500.00`
    const r = parse26as(txt)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].deductorTan).toBe('TVDC12345E')
  })

  it('puts the quarter in the financial year, not the calendar year', () => {
    const rows = ['A,TVDC12345E,194J,15-May-2026,F,10000,1000',
                  'B,TVDC12345E,194J,15-Aug-2026,F,10000,1000',
                  'C,TVDC12345E,194J,15-Nov-2026,F,10000,1000',
                  'D,TVDC12345E,194J,15-Feb-2027,F,10000,1000'].join('\n')
    expect(parse26as(rows).rows.map((r) => r.quarter)).toEqual([1, 2, 3, 4])
  })

  it('🔴 reports what it cannot read rather than dropping it', () => {
    const csv = `
1,CLICK AR BUSINESS,TVDC12345E,194J,30-Sep-2026,F,85000.00,8500.00
2,SOME CLIENT,NOTATAN,194J,30-Sep-2026,F,50000.00,5000.00
3,ANOTHER CLIENT,MUMN54321B,,30-Sep-2026,F,50000.00,5000.00
`.trim()
    const r = parse26as(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.skipped).toHaveLength(2)
    expect(r.skipped[0].reason).toMatch(/No deductor TAN/)
    expect(r.skipped[1].reason).toMatch(/No section code/)
    expect(r.skipped[0].line).toBe(2)
  })

  it('ignores headers and comment lines', () => {
    const csv = `# Form 26AS for AAUCA9985H
Sr. No.,Name,TAN,Section,Date,Status,Paid,Deducted
1,CLICK AR,TVDC12345E,194J,30-Sep-2026,F,85000.00,8500.00`
    const r = parse26as(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.skipped).toHaveLength(0)
  })

  it('strips rupee symbols and thousands separators', () => {
    const r = parse26as('1,CLICK AR,TVDC12345E,194J,30-Sep-2026,F,"₹1,00,300.00","₹8,500.00"')
    expect(r.rows[0].amountPaid.toFixed(2)).toBe('100300.00')
    expect(r.rows[0].tdsDeducted.toFixed(2)).toBe('8500.00')
  })

  it('falls back to the supplied quarter when no date is readable', () => {
    const r = parse26as('1,CLICK AR,TVDC12345E,194J,,F,85000.00,8500.00', 3)
    expect(r.rows[0].quarter).toBe(3)
    expect(r.rows[0].dateOfDeduction).toBeNull()
  })
})
