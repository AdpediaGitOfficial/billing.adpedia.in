import { describe, it, expect } from 'vitest'
import { Decimal } from '@/lib/money'
import { settleInFull } from '@/lib/settlement'

const D = (v: string) => new Decimal(v)
const show = (s: { amount: Decimal; tds: Decimal }) => [s.amount.toFixed(2), s.tds.toFixed(2)]

describe('settling an invoice in full', () => {
  it('🔴 splits the invoice into the cash that arrives and the tax withheld', () => {
    // ₹1,00,300 invoice, ₹8,500 withheld u/s 194J → the client sends ₹91,800
    expect(show(settleInFull(D('100300'), D('8500')))).toEqual(['91800.00', '8500.00'])
  })

  it('is all cash when the client withholds nothing', () => {
    expect(show(settleInFull(D('59000'), D('0')))).toEqual(['59000.00', '0.00'])
  })

  it('🔴 never proposes more TDS than is outstanding', () => {
    // after a part payment the balance can be smaller than the tax expected on the whole
    // invoice. Proposing the full tax would over-allocate, and the service would refuse it
    // with an error the person cannot act on.
    expect(show(settleInFull(D('5000'), D('8500')))).toEqual(['0.00', '5000.00'])
  })

  it('treats a settled invoice as nothing to do', () => {
    expect(show(settleInFull(D('0'), D('8500')))).toEqual(['0.00', '0.00'])
    expect(show(settleInFull(D('-10'), D('0')))).toEqual(['0.00', '0.00'])
  })

  it('ignores a negative TDS rather than inflating the cash', () => {
    expect(show(settleInFull(D('1000'), D('-50')))).toEqual(['1000.00', '0.00'])
  })

  it('rounds to paise, and the parts always add back to the whole', () => {
    const cases: [string, string][] = [
      ['100300', '8500'], ['59000', '5000'], ['236000', '4000'],
      ['141600', '12000'], ['1', '0.5'], ['0.03', '0.01'],
    ]
    for (const [total, tds] of cases) {
      const s = settleInFull(D(total), D(tds))
      expect(s.amount.plus(s.tds).toFixed(2)).toBe(D(total).toFixed(2))
    }
  })
})
