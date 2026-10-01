import { describe, it, expect } from 'vitest'
import { csvCell, csvRow, toCsv, csvMoney, UTF8_BOM } from '@/lib/csv'
import { Decimal } from '@/lib/money'

describe('CSV quoting', () => {
  it('quotes a value containing a comma so it stays in one column', () => {
    expect(csvCell('Click AR Business, Pvt Ltd')).toBe('"Click AR Business, Pvt Ltd"')
  })

  it('doubles an embedded quote', () => {
    expect(csvCell('Project "Prime"')).toBe('"Project ""Prime"""')
  })

  it('quotes newlines, which otherwise end the row', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('writes a date as ISO, not a locale string', () => {
    expect(csvCell(new Date('2026-09-30T12:00:00Z'))).toBe('2026-09-30')
  })

  it('writes null and undefined as empty, not "null"', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
})

describe('🔴 formula injection', () => {
  it('neutralises a cell that would execute in Excel', () => {
    // a vendor named this runs on the accountant's machine when they open our file
    expect(csvCell('=HYPERLINK("http://evil","click")')).toMatch(/^"?'=/)
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(csvCell('+1+1')).toBe("'+1+1")
  })

  it('🔴 leaves negative NUMBERS alone', () => {
    // the subtle one: "-" is also a formula lead. Prefixing it would turn every loss,
    // credit balance and cash outflow into text that refuses to sum.
    expect(csvCell('-71000.00')).toBe('-71000.00')
    expect(csvCell('-0.01')).toBe('-0.01')
    expect(csvCell(String(new Decimal('-1232900').toFixed(2)))).toBe('-1232900.00')
  })

  it('still neutralises text that merely starts with a minus', () => {
    expect(csvCell('-- adjustment')).toBe("'-- adjustment")
  })

  it('leaves ordinary text untouched', () => {
    expect(csvCell('Accounts Receivable')).toBe('Accounts Receivable')
    expect(csvCell('1010')).toBe('1010')
  })
})

describe('encoding and money', () => {
  it('🔴 starts the file with a BOM so Excel reads UTF-8', () => {
    // without it, Windows Excel renders Nuvé as NuvÃ© and ₹ as mojibake
    const out = toCsv([csvRow(['Client']), csvRow(['Nuvé Properties'])])
    expect(out.startsWith(UTF8_BOM)).toBe(true)
    expect(out).toContain('Nuvé Properties')
  })

  it('uses CRLF, which is what RFC 4180 and Excel expect', () => {
    expect(toCsv(['a', 'b'])).toBe(`${UTF8_BOM}a\r\nb\r\n`)
  })

  it('🔴 writes money as a plain decimal, never Indian-grouped', () => {
    // formatINR gives "1,00,300.00" — the commas split it across columns
    expect(csvMoney(new Decimal('100300'))).toBe('100300.00')
    expect(csvMoney('85000')).toBe('85000.00')
    expect(csvMoney(null)).toBe('0.00')
  })
})
