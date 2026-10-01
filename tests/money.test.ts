import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal, round2, round0, halveTax, sum, formatINR, formatCompactINR, amountInWords } from '@/lib/money'

describe('rounding', () => {
  it('rounds half up to paise', () => {
    expect(round2('7650.005').toFixed(2)).toBe('7650.01')
    expect(round2('7650.004').toFixed(2)).toBe('7650.00')
  })

  it('9% of 85,000 is exactly 7,650.00 — no float dust', () => {
    const tax = round2(new Decimal('85000').mul(9).div(100))
    expect(tax.toFixed(2)).toBe('7650.00')
  })

  it('rounds grand totals to whole rupees', () => {
    expect(round0('100299.60').toFixed(0)).toBe('100300')
  })
})

describe('halveTax — CGST/SGST split', () => {
  it('splits evenly when the tax is even', () => {
    const { cgst, sgst } = halveTax(new Decimal('15300'))
    expect(cgst.toFixed(2)).toBe('7650.00')
    expect(sgst.toFixed(2)).toBe('7650.00')
  })

  it('never loses or invents a paisa, for any tax amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_00 }), (paise) => {
        const tax = new Decimal(paise).div(100)
        const { cgst, sgst } = halveTax(tax)
        expect(cgst.plus(sgst).toFixed(2)).toBe(tax.toFixed(2))
      }),
      { numRuns: 500 },
    )
  })
})

describe('round per line then sum — docs/12 §3.2', () => {
  it('differs from sum-then-round, and we take the per-line answer', () => {
    // Three lines of 33.333: each rounds DOWN to 33.33, so the invoice totals 99.99.
    // Summing first gives 99.999 -> 100.00. The per-line figure is the correct one,
    // because each line's tax is printed on the invoice and must be right on its own.
    const lines = ['33.333', '33.333', '33.334']
    expect(sum(lines.map((l) => round2(l))).toFixed(2)).toBe('99.99')
    expect(round2(sum(lines)).toFixed(2)).toBe('100.00')

    // And the other direction: halves round UP per line, so per-line is larger.
    const odd = ['0.005', '0.005']
    expect(sum(odd.map(round2)).toFixed(2)).toBe('0.02')
    expect(round2(sum(odd)).toFixed(2)).toBe('0.01')
  })

  it('a rounded invoice total always reconciles to its stored roundOff', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5_000_00 }), { minLength: 1, maxLength: 12 }), (paise) => {
        const lineValues = paise.map((p) => round2(new Decimal(p).div(100)))
        const raw = sum(lineValues)
        const grand = round0(raw)
        const roundOff = grand.minus(raw)
        expect(raw.plus(roundOff).toFixed(2)).toBe(grand.toFixed(2))
        expect(roundOff.abs().lte(new Decimal('0.5'))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('Indian formatting', () => {
  it('groups in lakhs and crores, not thousands', () => {
    expect(formatINR('944000', { decimals: false })).toBe('₹9,44,000')
    expect(formatINR('100300')).toBe('₹1,00,300.00')
    expect(formatINR('12500000', { decimals: false })).toBe('₹1,25,00,000')
    expect(formatINR('999', { decimals: false })).toBe('₹999')
    expect(formatINR('-50000', { decimals: false })).toBe('-₹50,000')
  })

  it('compacts only for dashboard tiles', () => {
    expect(formatCompactINR('2540000')).toBe('₹25.4L')
    expect(formatCompactINR('12000000')).toBe('₹1.2Cr')
    expect(formatCompactINR('820000')).toBe('₹8.2L')
  })
})

describe('amountInWords — Rule 46 requirement', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords('100300')).toBe('Indian Rupees One Lakh Three Hundred Only')
    expect(amountInWords('91800')).toBe('Indian Rupees Ninety One Thousand Eight Hundred Only')
    expect(amountInWords('12500000')).toBe('Indian Rupees One Crore Twenty Five Lakh Only')
    expect(amountInWords('0')).toBe('Indian Rupees Zero Only')
  })

  it('handles paise', () => {
    expect(amountInWords('1250.50')).toBe('Indian Rupees One Thousand Two Hundred Fifty and Fifty Paise Only')
  })

  it('takes a currency label for export invoices', () => {
    expect(amountInWords('4200', 'US Dollars')).toBe('US Dollars Four Thousand Two Hundred Only')
  })
})
