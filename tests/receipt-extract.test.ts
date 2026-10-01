import { describe, it, expect } from 'vitest'
import { extractReceiptFields, panFromGstin } from '@/lib/receipt/extract'

describe('reading an Indian GST receipt', () => {
  it('pulls total, taxable, GST and rate off a well-formed bill', () => {
    const r = extractReceiptFields(`
      SPICE GARDEN RESTAURANT
      Thrissur, Kerala
      GSTIN: 32AAUCA9985H1ZX
      Date: 14/09/2026
      Taxable Value    1,200.00
      CGST 9%             108.00
      SGST 9%             108.00
      Grand Total      1,416.00
    `)
    expect(r.total).toBe('1416.00')
    expect(r.taxableValue).toBe('1200.00')
    expect(r.gstAmount).toBe('216.00')
    expect(r.gstRatePct).toBe('18')
    expect(r.date).toBe('2026-09-14')
    expect(r.gstin).toBe('32AAUCA9985H1ZX')
    expect(r.confidence).toBe('high')
  })

  it('🔴 reads dates day-first, the Indian way', () => {
    // 01/10/2026 is 1 October. Read the American way it becomes 10 January — a different
    // quarter, so the expense lands in the wrong GST return and the ITC is claimed late.
    expect(extractReceiptFields('Date 01/10/2026').date).toBe('2026-10-01')
    expect(extractReceiptFields('Dt. 5-3-26').date).toBe('2026-03-05')
    expect(extractReceiptFields('Invoice Date: 14 Oct 2026').date).toBe('2026-10-14')
    expect(extractReceiptFields('2026-10-01').date).toBe('2026-10-01')
  })

  it('rejects a date that is not a real date', () => {
    expect(extractReceiptFields('Ref 45/99/2026').date).toBeNull()
  })

  it('handles Indian digit grouping, which is 2,2,3 and not 3,3,3', () => {
    const r = extractReceiptFields('Total ₹1,23,456.78')
    expect(r.total).toBe('123456.78')
  })

  it('falls back to the largest figure when nothing is labelled "total"', () => {
    const r = extractReceiptFields(`
      CHAI POINT
      Item A   120.00
      Item B    80.00
      ₹200.00
    `)
    expect(r.total).toBe('200.00')
  })

  it('🔴 drops taxable and GST when the parts do not add up to the total', () => {
    // a misread digit is worse than a blank field: the person would accept a wrong
    // pre-fill without re-reading the receipt
    const r = extractReceiptFields(`
      Taxable Value  1,200.00
      Total          9,999.00
      CGST             108.00
    `)
    expect(r.total).toBe('9999.00')
    expect(r.taxableValue).toBeNull()
    expect(r.gstAmount).toBeNull()
  })

  it('derives the missing third figure when two are present', () => {
    const r = extractReceiptFields('Subtotal 1000.00\nGrand Total 1180.00')
    expect(r.gstAmount).toBe('180.00')
    expect(r.gstRatePct).toBe('18')
  })

  it('snaps the rate to a real GST slab rather than reporting OCR noise', () => {
    const r = extractReceiptFields('Subtotal 1000.00\nTotal 1179.00')
    expect(r.gstRatePct).toBe('18')      // 17.9% snaps
    const odd = extractReceiptFields('Subtotal 1000.00\nTotal 1250.00')
    expect(odd.gstRatePct).toBeNull()    // 25% is not a slab — say nothing
  })

  it('reports low confidence on an unreadable scrap, rather than guessing', () => {
    const r = extractReceiptFields('thank you for visiting')
    expect(r.total).toBeNull()
    expect(r.confidence).toBe('low')
    expect(r.candidateAmounts).toEqual([])
  })

  it('offers every amount found so a wrong pick can be corrected in one tap', () => {
    const r = extractReceiptFields('A 120.00\nB 80.00\nTotal 200.00')
    expect(r.candidateAmounts).toEqual(['200.00', '120.00', '80.00'])
  })

  it('takes the vendor name from the letterhead, not a total line', () => {
    const r = extractReceiptFields('SPICE GARDEN RESTAURANT\nGSTIN 32AAUCA9985H1ZX\nTotal 500.00')
    expect(r.vendorName).toBe('SPICE GARDEN RESTAURANT')
  })

  it('🔴 adds CGST and SGST instead of taking one of them', () => {
    // the halves are on separate lines; taking either alone halves the tax, the receipt
    // then fails its own add-up check, and BOTH figures get discarded
    const r = extractReceiptFields(`
      Taxable Value  1,200.00
      CGST 9%          108.00
      SGST 9%          108.00
      Grand Total    1,416.00
    `)
    expect(r.gstAmount).toBe('216.00')
    expect(r.gstRatePct).toBe('18')
  })

  it('takes an inter-state IGST line whole', () => {
    const r = extractReceiptFields('Taxable 1000.00\nIGST 18%  180.00\nTotal 1180.00')
    expect(r.gstAmount).toBe('180.00')
    expect(r.gstRatePct).toBe('18')
  })

  it('extracts the PAN out of a GSTIN so the vendor can be matched', () => {
    expect(panFromGstin('32AAUCA9985H1ZX')).toBe('AAUCA9985H')
    expect(panFromGstin('not a gstin')).toBeNull()
  })
})
