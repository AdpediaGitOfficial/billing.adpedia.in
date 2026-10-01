import { describe, it, expect } from 'vitest'
import { Decimal } from '@/lib/money'
import { panEntity, isCompanyOrFirm, isValidPanFormat, panEntityLabel } from '@/server/services/tax/pan'

const D = (v: string | number) => new Decimal(v)

describe('PAN entity decoding', () => {
  it('reads the entity type from the 4th character', () => {
    expect(panEntity('AAUCA9985H')).toBe('COMPANY')      // Adpedia's own PAN — C
    expect(panEntity('ABCPD1234E')).toBe('INDIVIDUAL')   // P
    expect(panEntity('ABCFD1234E')).toBe('FIRM')         // F
    expect(panEntity('ABCHD1234E')).toBe('HUF')          // H
    expect(panEntity('ABCTD1234E')).toBe('TRUST')        // T
  })

  it('decides the 194C rate split', () => {
    expect(isCompanyOrFirm('AAUCA9985H')).toBe(true)     // company -> 2%
    expect(isCompanyOrFirm('ABCPD1234E')).toBe(false)    // individual -> 1%
    expect(isCompanyOrFirm('ABCHD1234E')).toBe(false)    // HUF -> 1%
    expect(isCompanyOrFirm('ABCFD1234E')).toBe(true)     // firm -> 2%
  })

  it('validates the format', () => {
    expect(isValidPanFormat('AAUCA9985H')).toBe(true)
    expect(isValidPanFormat('AAUCA998SH')).toBe(false)   // letter where a digit belongs
    expect(isValidPanFormat('AAUCA9985')).toBe(false)    // too short
    expect(isValidPanFormat(null)).toBe(false)
    expect(isValidPanFormat('')).toBe(false)
  })

  it('labels the entity for the UI', () => {
    expect(panEntityLabel('AAUCA9985H')).toBe('Company')
    expect(panEntityLabel('ABCPD1234E')).toBe('Individual')
    expect(panEntityLabel(null)).toBe('Unknown')
  })

  it('is case- and whitespace-tolerant', () => {
    expect(panEntity('  aauca9985h  ')).toBe('COMPANY')
  })
})

describe('the arithmetic of a threshold crossing', () => {
  // mirrors resolveTds step 4 without touching the database
  function crossing(cumulativeBefore: string, thisBill: string, annual: string, rate: string) {
    const before = D(cumulativeBefore), bill = D(thisBill), limit = D(annual), r = D(rate)
    const after = before.plus(bill)
    const crossed = before.lte(limit) && after.gt(limit)
    return {
      crossed,
      applyOn: crossed ? after : after.gt(limit) ? bill : D(0),
      tds: (crossed ? after : after.gt(limit) ? bill : D(0)).mul(r).div(100).toDecimalPlaces(2),
    }
  }

  it('🔴 deducts on the WHOLE year when the limit is crossed, not the excess', () => {
    // Praveen C D: ₹18,500 so far, a ₹40,000 bill takes him past ₹50,000
    const r = crossing('18500', '40000', '50000', '10')
    expect(r.crossed).toBe(true)
    expect(r.applyOn.toFixed(2)).toBe('58500.00')   // not 8,500 of excess
    expect(r.tds.toFixed(2)).toBe('5850.00')
  })

  it('deducts nothing while still under', () => {
    const r = crossing('18500', '10000', '50000', '10')
    expect(r.crossed).toBe(false)
    expect(r.tds.toFixed(2)).toBe('0.00')
  })

  it('once past, later bills are taxed on themselves alone', () => {
    const r = crossing('58500', '30000', '50000', '10')
    expect(r.crossed).toBe(false)
    expect(r.applyOn.toFixed(2)).toBe('30000.00')
    expect(r.tds.toFixed(2)).toBe('3000.00')
  })

  it('a single bill that clears the limit outright still taxes the whole amount', () => {
    const r = crossing('0', '80000', '50000', '10')
    expect(r.crossed).toBe(true)
    expect(r.applyOn.toFixed(2)).toBe('80000.00')
    expect(r.tds.toFixed(2)).toBe('8000.00')
  })
})

describe('TDS base excludes GST', () => {
  it('194J on ₹2,00,000 + 18% GST is ₹20,000, not ₹23,600', () => {
    const taxable = D('200000'), gst = taxable.mul(18).div(100)
    expect(taxable.plus(gst).toFixed(2)).toBe('236000.00')
    expect(taxable.mul(10).div(100).toFixed(2)).toBe('20000.00')    // Circular 23/2017
    expect(taxable.plus(gst).mul(10).div(100).toFixed(2)).toBe('23600.00')  // the wrong answer
  })
})
