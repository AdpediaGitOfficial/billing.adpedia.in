import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Decimal } from '@/lib/money'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'

const inv = (grandTotal: string, received = '0', tdsCredited = '0', tdsAmount = '0') =>
  ({ grandTotal, amountReceived: received, tdsCredited, tdsAmount })
const notes = (credited: string, debited = '0') =>
  ({ credited: new Decimal(credited), debited: new Decimal(debited) })

describe('invoiceOpen', () => {
  it('with no notes, is what the old arithmetic said', () => {
    const o = invoiceOpen(inv('118000'), NO_NOTES)
    expect(o.gross.toFixed(2)).toBe('118000.00')
    expect(o.outstanding.toFixed(2)).toBe('118000.00')
    expect(o.collectible.toFixed(2)).toBe('118000.00')
    expect(o.settled).toBe(false)
  })

  it('🔴 subtracts a credit note from what is owed', () => {
    const o = invoiceOpen(inv('118000'), notes('23600'))
    expect(o.issued.toFixed(2)).toBe('118000.00')
    expect(o.gross.toFixed(2)).toBe('94400.00')
    expect(o.outstanding.toFixed(2)).toBe('94400.00')
  })

  it('🔴 adds a debit note to it', () => {
    const o = invoiceOpen(inv('118000'), notes('0', '11800'))
    expect(o.gross.toFixed(2)).toBe('129800.00')
    expect(o.outstanding.toFixed(2)).toBe('129800.00')
  })

  it('nets the two against each other', () => {
    const o = invoiceOpen(inv('118000'), notes('23600', '11800'))
    expect(o.gross.toFixed(2)).toBe('106200.00')
  })

  it('an invoice credited in full owes nothing and is settled', () => {
    const o = invoiceOpen(inv('118000'), notes('118000'))
    expect(o.gross.toFixed(2)).toBe('0.00')
    expect(o.outstanding.toFixed(2)).toBe('0.00')
    expect(o.collectible.toFixed(2)).toBe('0.00')
    expect(o.settled).toBe(true)
  })

  it('a payment of what is left settles a credited invoice', () => {
    const o = invoiceOpen(inv('118000', '94400'), notes('23600'))
    expect(o.outstanding.toFixed(2)).toBe('0.00')
    expect(o.settled).toBe(true)
  })

  it('never reports a negative debt, however much was received', () => {
    const o = invoiceOpen(inv('118000', '118000'), notes('23600'))
    expect(o.outstanding.toFixed(2)).toBe('0.00')
    expect(o.collectible.toFixed(2)).toBe('0.00')
  })

  it('TDS already credited counts as settlement, not as cash', () => {
    const o = invoiceOpen(inv('118000', '108000', '10000', '10000'))
    expect(o.outstanding.toFixed(2)).toBe('0.00')
    expect(o.tdsExpected.toFixed(2)).toBe('0.00')
    expect(o.settled).toBe(true)
  })

  it('collectible is net of the TDS the client has yet to withhold', () => {
    const o = invoiceOpen(inv('118000', '0', '0', '10000'))
    expect(o.tdsExpected.toFixed(2)).toBe('10000.00')
    expect(o.collectible.toFixed(2)).toBe('108000.00')
  })

  it('🔴 caps the expected TDS at what is outstanding', () => {
    // credited down to ₹5,000 with ₹10,000 of TDS still notionally expected: the withholding
    // cannot exceed the debt, or collectible would go negative and the row would vanish
    const o = invoiceOpen(inv('118000', '0', '0', '10000'), notes('113000'))
    expect(o.gross.toFixed(2)).toBe('5000.00')
    expect(o.tdsExpected.toFixed(2)).toBe('5000.00')
    expect(o.collectible.toFixed(2)).toBe('0.00')
  })

  it('reads Prisma Decimals and strings alike', () => {
    const o = invoiceOpen(inv(new Decimal('118000') as unknown as string), notes('23600'))
    expect(o.gross.toFixed(2)).toBe('94400.00')
  })

  it('treats a missing figure as zero rather than NaN', () => {
    const o = invoiceOpen({ grandTotal: '118000', amountReceived: null, tdsCredited: undefined, tdsAmount: null })
    expect(o.outstanding.toFixed(2)).toBe('118000.00')
  })
})

/* ── the guard ────────────────────────────────────────────────────────────── */

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/**
 * 🔴 docs/86 — the sweep that stops the ninth copy becoming a tenth.
 *
 * The defect was not one wrong line; it was the same three-term subtraction written out nine
 * times, so every new report that needed "what is still owed" wrote it again and got it wrong
 * again. The arithmetic now lives in `invoiceOpen`, and this fails the build if anything
 * subtracts `amountReceived` from `grandTotal` outside it.
 */
describe('🔴 no tenth copy of the outstanding arithmetic', () => {
  const sources = files('src').filter((p) => !p.endsWith(join('lib', 'invoice-open.ts')))
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
       .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))

  it('sees the code it is sweeping', () => {
    // 🔴 the sweep has to prove it can find the thing before a clean run means anything
    expect(sources.length).toBeGreaterThan(200)
    const users = sources.filter((p) => /invoiceOpen\(/.test(code(readFileSync(p, 'utf8'))))
    expect(users.length).toBeGreaterThanOrEqual(8)
  })

  it('nothing subtracts amountReceived from grandTotal by hand', () => {
    const offenders: string[] = []
    for (const p of sources) {
      const src = code(readFileSync(p, 'utf8'))
      // `.minus(` chains and `-` alike, within one statement of each other
      for (const m of src.matchAll(/grandTotal[\s\S]{0,200}?amountReceived/g)) {
        const between = m[0]
        if (/minus|[-]\s/.test(between)) {
          offenders.push(`${p}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('nothing re-derives the expected TDS by hand', () => {
    const offenders: string[] = []
    for (const p of sources) {
      const src = code(readFileSync(p, 'utf8'))
      for (const m of src.matchAll(/tdsAmount[\s\S]{0,80}?minus[\s\S]{0,40}?tdsCredited/g)) {
        offenders.push(`${p}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
