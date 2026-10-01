import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal } from '@/lib/money'
import { resolveTaxMode, isZeroRated, requiresLut, allowsTds, placeOfSupplyLabel, stateCodeFromGstin } from '@/server/services/tax/tax-mode'
import { computeInvoice, sacSummary, type LineInput } from '@/server/services/tax/gst'
import { computeInvoiceTds } from '@/server/services/tax/tds'

const ADPEDIA = { stateCode: '32' }           // Kerala
const D = (v: string | number) => new Decimal(v)

describe('tax mode — derived, never chosen', () => {
  it('Kerala customer is intra-state', () => {
    expect(resolveTaxMode(ADPEDIA, { country: 'IN', stateCode: '32', customerType: 'B2B' })).toBe('INTRA')
  })

  it('any other Indian state is inter-state', () => {
    expect(resolveTaxMode(ADPEDIA, { country: 'IN', stateCode: '27', customerType: 'B2B' })).toBe('INTER')
    expect(resolveTaxMode(ADPEDIA, { country: 'IN', stateCode: '29', customerType: 'B2C' })).toBe('INTER')
  })

  it('overseas is export, even when stateCode is null', () => {
    expect(resolveTaxMode(ADPEDIA, { country: 'AE', stateCode: null, customerType: 'EXPORT' })).toBe('EXPORT')
  })

  it('🔴 a null stateCode on an overseas customer can never read as intra-state', () => {
    // country is tested first precisely so this cannot happen
    expect(resolveTaxMode({ stateCode: '32' }, { country: 'US', stateCode: null, customerType: 'B2B' })).toBe('EXPORT')
    expect(resolveTaxMode({ stateCode: '32' }, { country: 'IN', stateCode: null, customerType: 'B2B' })).toBe('INTER')
  })

  it('SEZ depends on whether IGST is paid', () => {
    const sez = { country: 'IN', stateCode: '32', customerType: 'SEZ' as const }
    expect(resolveTaxMode(ADPEDIA, sez)).toBe('SEZ_WITHOUT_PAY')
    expect(resolveTaxMode(ADPEDIA, sez, { sezWithPayment: true })).toBe('SEZ_WITH_PAY')
  })

  it('zero-rated modes need a LUT; export forbids TDS', () => {
    expect(isZeroRated('EXPORT')).toBe(true)
    expect(requiresLut('EXPORT')).toBe(true)
    expect(requiresLut('INTRA')).toBe(false)
    expect(allowsTds('EXPORT')).toBe(false)
    expect(allowsTds('INTER')).toBe(true)
  })

  it('labels the place of supply', () => {
    expect(placeOfSupplyLabel('INTRA', '32')).toBe('Kerala (32)')
    expect(placeOfSupplyLabel('INTER', '27')).toBe('Maharashtra (27)')
    expect(placeOfSupplyLabel('EXPORT', null)).toBe('Outside India (96 – Other Country)')
  })

  it('reads the state code out of a GSTIN', () => {
    expect(stateCodeFromGstin('32AAUCA9985H1ZX')).toBe('32')
    expect(stateCodeFromGstin('27AABCN1234M1Z5')).toBe('27')
    expect(stateCodeFromGstin(null)).toBeNull()
  })
})

// the real sample invoice from docs/03 §5
const SAMPLE: LineInput[] = [
  { description: 'Staff augmentation', sacCode: '998314', quantity: D(1), rate: D('70000'), gstRatePct: D(18) },
  { description: 'UI/UX revisions', sacCode: '998391', quantity: D(2), rate: D('7500'), gstRatePct: D(18) },
]

describe('invoice totals — the real ADP/26-27/0026 figures', () => {
  it('intra-state: 85,000 + 7,650 + 7,650 = 1,00,300', () => {
    const t = computeInvoice(SAMPLE, 'INTRA')
    expect(t.taxableValue.toFixed(2)).toBe('85000.00')
    expect(t.cgst.toFixed(2)).toBe('7650.00')
    expect(t.sgst.toFixed(2)).toBe('7650.00')
    expect(t.igst.toFixed(2)).toBe('0.00')
    expect(t.grandTotal.toFixed(2)).toBe('100300.00')
    expect(t.roundOff.toFixed(2)).toBe('0.00')
  })

  it('inter-state: same total, carried as IGST', () => {
    const t = computeInvoice(SAMPLE, 'INTER')
    expect(t.igst.toFixed(2)).toBe('15300.00')
    expect(t.cgst.toFixed(2)).toBe('0.00')
    expect(t.grandTotal.toFixed(2)).toBe('100300.00')
  })

  it('export: zero-rated, total equals the taxable value', () => {
    const t = computeInvoice(SAMPLE, 'EXPORT')
    expect(t.taxTotal.toFixed(2)).toBe('0.00')
    expect(t.grandTotal.toFixed(2)).toBe('85000.00')
  })
})

describe('rounding invariants', () => {
  it('CGST + SGST always equals the total tax, for any line', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_00 }), (paise) => {
        const t = computeInvoice([{ description: 'x', quantity: D(1), rate: new Decimal(paise).div(100), gstRatePct: D(18) }], 'INTRA')
        const expected = new Decimal(paise).div(100).toDecimalPlaces(2).mul(18).div(100).toDecimalPlaces(2)
        expect(t.cgst.plus(t.sgst).toFixed(2)).toBe(expected.toFixed(2))
      }),
      { numRuns: 400 },
    )
  })

  it('grandTotal is always a whole rupee and reconciles via roundOff', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 8 }),
        (rates) => {
          const lines = rates.map((r) => ({ description: 'x', quantity: D(1), rate: new Decimal(r).div(100), gstRatePct: D(18) }))
          const t = computeInvoice(lines, 'INTRA')
          expect(t.grandTotal.mod(1).toNumber()).toBe(0)
          expect(t.rawTotal.plus(t.roundOff).toFixed(2)).toBe(t.grandTotal.toFixed(2))
          expect(t.roundOff.abs().lte(new Decimal('0.5'))).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('an odd paisa lands on SGST rather than disappearing', () => {
    // taxable 100.05 @ 18% = 18.009 -> 18.01; halved = 9.005 -> 9.01 and 9.00
    const t = computeInvoice([{ description: 'x', quantity: D(1), rate: D('100.05'), gstRatePct: D(18) }], 'INTRA')
    expect(t.cgst.plus(t.sgst).toFixed(2)).toBe('18.01')
  })
})

describe('HSN/SAC summary', () => {
  it('groups by SAC and totals each', () => {
    const t = computeInvoice(SAMPLE, 'INTRA')
    const s = sacSummary(t.lines)
    expect(s).toHaveLength(2)
    expect(s[0].sacCode).toBe('998314')
    expect(s[0].taxableValue.toFixed(2)).toBe('70000.00')
    expect(s[0].cgst.toFixed(2)).toBe('6300.00')
    expect(s[1].taxableValue.toFixed(2)).toBe('15000.00')
  })
})

describe('TDS expected on the invoice', () => {
  it('194J @10% on the taxable value, not the gross — Circular 23/2017', () => {
    const t = computeInvoice(SAMPLE, 'INTRA')
    const tds = computeInvoiceTds({ taxableValue: t.taxableValue, grandTotal: t.grandTotal, section: '194J', ratePct: D(10), mode: 'INTRA' })
    expect(tds.baseAmount.toFixed(2)).toBe('85000.00')   // not 100300
    expect(tds.tdsAmount.toFixed(2)).toBe('8500.00')
    expect(tds.netPayable.toFixed(2)).toBe('91800.00')
  })

  it('194C @2%', () => {
    const t = computeInvoice(SAMPLE, 'INTER')
    const tds = computeInvoiceTds({ taxableValue: t.taxableValue, grandTotal: t.grandTotal, section: '194C', ratePct: D(2), mode: 'INTER' })
    expect(tds.tdsAmount.toFixed(2)).toBe('1700.00')
    expect(tds.netPayable.toFixed(2)).toBe('98600.00')
  })

  it('🔴 never applies to an export invoice, even if a section is set', () => {
    const t = computeInvoice(SAMPLE, 'EXPORT')
    const tds = computeInvoiceTds({ taxableValue: t.taxableValue, grandTotal: t.grandTotal, section: '194J', ratePct: D(10), mode: 'EXPORT' })
    expect(tds.tdsAmount.toFixed(2)).toBe('0.00')
    expect(tds.section).toBeNull()
    expect(tds.netPayable.toFixed(2)).toBe('85000.00')
  })
})

describe('AR ageing treats expected TDS as not collectible', () => {
  // mirrors receivables.ts without touching the database
  function collectible(grandTotal: string, received: string, tdsCredited: string, tdsOnInvoice: string) {
    const gt = D(grandTotal), rc = D(received), tc = D(tdsCredited), ti = D(tdsOnInvoice)
    const expected = Decimal.max(ti.minus(tc), D(0))
    return Decimal.max(gt.minus(rc).minus(tc).minus(expected), D(0))
  }

  it('an unpaid invoice is collectible net of the TDS the client will deduct', () => {
    // ₹1,00,300 invoice, 194J @10% on ₹85,000 -> only ₹91,800 is ever cash
    expect(collectible('100300', '0', '0', '8500').toFixed(2)).toBe('91800.00')
  })

  it('🔴 a fully settled invoice shows ZERO, not the TDS amount', () => {
    // client paid ₹91,800 and kept ₹8,500 — nothing left to chase
    expect(collectible('100300', '91800', '8500', '8500').toFixed(2)).toBe('0.00')
  })

  it('a part payment leaves only the remaining cash', () => {
    expect(collectible('100300', '50000', '0', '8500').toFixed(2)).toBe('41800.00')
  })

  it('an invoice with no TDS is collectible in full', () => {
    expect(collectible('100300', '0', '0', '0').toFixed(2)).toBe('100300.00')
  })
})
