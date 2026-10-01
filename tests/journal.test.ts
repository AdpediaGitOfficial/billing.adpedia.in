import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal } from '@/lib/money'
import { assertBalanced, totals } from '@/server/services/accounting/journal'
import type { Posting } from '@/server/services/accounting/types'
import { UnbalancedJournal } from '@/server/errors'

const D = (v: string | number) => new Decimal(v)

describe('assertBalanced — non-negotiable #1', () => {
  it('accepts a balanced entry', () => {
    const p: Posting[] = [
      { accountCode: '1100', debit: D('100300.00') },
      { accountCode: '4020', credit: D('70000.00') },
      { accountCode: '4030', credit: D('15000.00') },
      { accountCode: '2110', credit: D('7650.00') },
      { accountCode: '2120', credit: D('7650.00') },
    ]
    expect(() => assertBalanced(p)).not.toThrow()
    const t = totals(p)
    expect(t.debit.toFixed(2)).toBe('100300.00')
    expect(t.credit.toFixed(2)).toBe('100300.00')
  })

  it('rejects an entry that is off by one paisa', () => {
    expect(() =>
      assertBalanced([
        { accountCode: '1100', debit: D('100300.00') },
        { accountCode: '4020', credit: D('100299.99') },
      ]),
    ).toThrow(UnbalancedJournal)
  })

  it('rejects empty, negative, zero and two-sided postings', () => {
    expect(() => assertBalanced([])).toThrow(/no postings/)
    expect(() => assertBalanced([{ accountCode: '1100', debit: D('-5') }, { accountCode: '4020', credit: D('-5') }])).toThrow(/negative/)
    expect(() => assertBalanced([{ accountCode: '1100' }, { accountCode: '4020' }])).toThrow(/zero-value/)
    expect(() => assertBalanced([{ accountCode: '1100', debit: D('5'), credit: D('5') }])).toThrow(/both debit and credit/)
  })

  it('names the difference so the error is actionable', () => {
    expect(() =>
      assertBalanced([{ accountCode: '1100', debit: D('1000') }, { accountCode: '4020', credit: D('900') }], 'invoice ADP/26-27/0026'),
    ).toThrow(/invoice ADP\/26-27\/0026.*₹100\.00/)
  })
})

describe('property: any entry built as debits-mirroring-credits balances', () => {
  it('holds for arbitrary amounts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000_00 }), { minLength: 1, maxLength: 20 }),
        (paise) => {
          const credits: Posting[] = paise.map((p, i) => ({ accountCode: `40${i}0`, credit: new Decimal(p).div(100) }))
          const total = credits.reduce((a, c) => a.plus(c.credit!), new Decimal(0))
          const postings: Posting[] = [{ accountCode: '1100', debit: total }, ...credits]
          expect(() => assertBalanced(postings)).not.toThrow()
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('the real Adpedia postings from docs/12 §2', () => {
  it('receipt with TDS deducted by the customer', () => {
    const p: Posting[] = [
      { accountCode: '1010', debit: D('91800.00') },
      { accountCode: '1310', debit: D('8500.00') },
      { accountCode: '1100', credit: D('100300.00') },
    ]
    expect(() => assertBalanced(p)).not.toThrow()
  })

  it('DigitalOcean reverse charge nets to zero cost', () => {
    const bill: Posting[] = [
      { accountCode: '5310', debit: D('25000.00') },
      { accountCode: '2000', credit: D('25000.00') },
    ]
    const rcm: Posting[] = [
      { accountCode: '1240', debit: D('4500.00') },
      { accountCode: '2140', credit: D('4500.00') },
    ]
    expect(() => assertBalanced(bill)).not.toThrow()
    expect(() => assertBalanced(rcm)).not.toThrow()
    // the RCM credit taken back as ITC cancels the liability paid in cash
    expect(totals(rcm).debit.minus(totals(rcm).credit).toFixed(2)).toBe('0.00')
  })

  it('payroll run for the four salaried people', () => {
    const p: Posting[] = [
      { accountCode: '5110', debit: D('238000.00') },   // Shinelal — director
      { accountCode: '5120', debit: D('212000.00') },   // Akash, Deepak, Kiran
      { accountCode: '2210', credit: D('95000.00') },   // s.192
      { accountCode: '2310', credit: D('1000.00') },    // Kerala profession tax
      { accountCode: '2300', credit: D('354000.00') },
    ]
    expect(() => assertBalanced(p)).not.toThrow()
  })
})
