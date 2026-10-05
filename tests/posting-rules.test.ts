import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal, ZERO } from '@/lib/money'
import { assertBalanced, totals } from '@/server/services/accounting/journal'
import { postInvoice, postReceipt, revenueFromLines } from '@/server/services/accounting/rules/invoice'
import { computeInvoice, type LineInput } from '@/server/services/tax/gst'
import { renderPattern, validateInvoiceNumber } from '@/server/services/invoicing/numbering'
import { shortFy } from '@/lib/fy'

const D = (v: string | number) => new Decimal(v)

const SAMPLE: LineInput[] = [
  { description: 'Staff augmentation', sacCode: '998314', quantity: D(1), rate: D('70000'), gstRatePct: D(18) },
  { description: 'UI/UX revisions', sacCode: '998391', quantity: D(2), rate: D('7500'), gstRatePct: D(18) },
]

function invoiceDoc(mode: 'INTRA' | 'INTER' | 'EXPORT') {
  const t = computeInvoice(SAMPLE, mode)
  return {
    number: 'ADP/26-27/0026',
    customerId: 'cust1',
    projectId: 'proj1',
    grandTotal: t.grandTotal,
    cgst: t.cgst, sgst: t.sgst, igst: t.igst, roundOff: t.roundOff,
    revenueByAccount: revenueFromLines([
      { taxableValue: t.lines[0].taxableValue, incomeAccountCode: '4020' },
      { taxableValue: t.lines[1].taxableValue, incomeAccountCode: '4030' },
    ]),
  }
}

describe('postInvoice', () => {
  it('balances for every tax mode', () => {
    for (const mode of ['INTRA', 'INTER', 'EXPORT'] as const) {
      expect(() => assertBalanced(postInvoice(invoiceDoc(mode)), mode)).not.toThrow()
    }
  })

  it('intra-state produces the docs/12 §2.1 entry exactly', () => {
    const p = postInvoice(invoiceDoc('INTRA'))
    const byAccount = Object.fromEntries(p.map((x) => [x.accountCode, (x.debit ?? x.credit)!.toFixed(2)]))
    expect(byAccount['1100']).toBe('100300.00')
    expect(byAccount['4020']).toBe('70000.00')
    expect(byAccount['4030']).toBe('15000.00')
    expect(byAccount['2110']).toBe('7650.00')
    expect(byAccount['2120']).toBe('7650.00')
    expect(p.find((x) => x.accountCode === '2130')).toBeUndefined()   // no IGST line
  })

  it('export carries no GST lines at all', () => {
    const p = postInvoice(invoiceDoc('EXPORT'))
    expect(p.some((x) => ['2110', '2120', '2130'].includes(x.accountCode))).toBe(false)
    expect(totals(p).debit.toFixed(2)).toBe('85000.00')
  })

  it('🔴 never books TDS at invoice time — the customer may not deduct', () => {
    const p = postInvoice(invoiceDoc('INTRA'))
    expect(p.some((x) => x.accountCode.startsWith('13'))).toBe(false)
  })

  it('carries customer and project dimensions on every line', () => {
    for (const p of postInvoice(invoiceDoc('INTRA'))) {
      expect(p.customerId).toBe('cust1')
      expect(p.projectId).toBe('proj1')
    }
  })

  /**
   * 🔴 There used to be a `postInvoiceReversal` here, and a test for it, and nothing ever
   * called it — docs/80.
   *
   * It recomputed the postings from the DOCUMENT and flipped them. `cancelInvoice` reverses
   * the journal ENTRY that was actually posted, which is not the same thing: a posting rule
   * that changed between issue and cancellation — docs/67 moved revenue off the 4010 fallback
   * onto each service's own income account — would have made the recomputed version reverse
   * entries that were never made. The test made the wrong way read as covered.
   */
})

describe('postReceipt', () => {
  it('the real case: ₹91,800 cash + ₹8,500 TDS clears ₹1,00,300 of AR', () => {
    const p = postReceipt({
      number: 'ADP/RC/26-27/0001', customerId: 'cust1', projectId: 'proj1',
      amount: D('91800'), tdsAmount: D('8500'), tdsSection: '194J',
      bankCharge: ZERO, fxGainLoss: ZERO, bankAccountCode: '1010',
    })
    expect(() => assertBalanced(p)).not.toThrow()
    const by = Object.fromEntries(p.map((x) => [x.accountCode, (x.debit ?? x.credit)!.toFixed(2)]))
    expect(by['1010']).toBe('91800.00')
    expect(by['1310']).toBe('8500.00')   // TDS receivable — 194J
    expect(by['1100']).toBe('100300.00')
  })

  it('194C routes to its own TDS receivable account', () => {
    const p = postReceipt({
      number: 'r', customerId: 'c', amount: D('98600'), tdsAmount: D('1700'), tdsSection: '194C',
      bankCharge: ZERO, fxGainLoss: ZERO, bankAccountCode: '1010',
    })
    expect(p.find((x) => x.accountCode === '1320')?.debit?.toFixed(2)).toBe('1700.00')
  })

  it('an export receipt short by bank charges still balances', () => {
    const p = postReceipt({
      number: 'r', customerId: 'c', amount: D('84500'), tdsAmount: ZERO, tdsSection: null,
      bankCharge: D('500'), fxGainLoss: ZERO, bankAccountCode: '1010',
    })
    expect(() => assertBalanced(p)).not.toThrow()
    expect(p.find((x) => x.accountCode === '1100')?.credit?.toFixed(2)).toBe('85000.00')
  })

  it('balances for arbitrary cash / TDS / charge combinations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_00 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 50_000 }),
        (cash, tds, charge) => {
          const p = postReceipt({
            number: 'r', customerId: 'c',
            amount: new Decimal(cash).div(100), tdsAmount: new Decimal(tds).div(100), tdsSection: '194J',
            bankCharge: new Decimal(charge).div(100), fxGainLoss: ZERO, bankAccountCode: '1010',
          })
          expect(() => assertBalanced(p)).not.toThrow()
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('invoice numbering', () => {
  it('renders the Adpedia pattern', () => {
    expect(renderPattern('ADP/{FY}/{SEQ:4}', { FY: '26-27', SEQ: 26 })).toBe('ADP/26-27/0026')
    expect(renderPattern('ADPX/{FY}/{SEQ:4}', { FY: '26-27', SEQ: 4 })).toBe('ADPX/26-27/0004')
    expect(renderPattern('ADP/{FY}/{SEQ}', { FY: '26-27', SEQ: 7 })).toBe('ADP/26-27/7')
  })

  it('enforces Rule 46 limits', () => {
    expect(validateInvoiceNumber('ADP/26-27/0026')).toEqual({ ok: true })
    expect(validateInvoiceNumber('ADPX/26-27/0004')).toEqual({ ok: true })

    // 🔴 regression guard: the original export pattern rendered 18 characters
    const over = validateInvoiceNumber('ADP/EXP/26-27/0004')
    expect(over.ok).toBe(false)
    expect(over).toHaveProperty('reason', expect.stringContaining('18 characters'))

    // every seeded series must stay inside the limit at its highest sequence
    for (const pattern of ['ADP/{FY}/{SEQ:4}', 'ADPX/{FY}/{SEQ:4}', 'ADPC/{FY}/{SEQ:4}', 'ADPR/{FY}/{SEQ:4}', 'ADPS/{FY}/{SEQ:4}', 'ADPP/{FY}/{SEQ:4}']) {
      expect(validateInvoiceNumber(renderPattern(pattern, { FY: '26-27', SEQ: 9999 }))).toEqual({ ok: true })
    }
    const tooLong = validateInvoiceNumber('ADPEDIA-FILMS/26-27/000026')
    expect(tooLong.ok).toBe(false)
    const badChars = validateInvoiceNumber('ADP#26-27#0026')
    expect(badChars.ok).toBe(false)
  })
})

describe('short financial-year form in document numbers', () => {
  it('🔴 the stored label is 2026-27 but numbers must carry 26-27', () => {
    expect(shortFy('2026-27')).toBe('26-27')
    expect(shortFy('2025-26')).toBe('25-26')
    // the full label would push every series over the Rule 46 limit
    expect(validateInvoiceNumber(renderPattern('ADPX/{FY}/{SEQ:4}', { FY: '2026-27', SEQ: 1 })).ok).toBe(false)
    expect(validateInvoiceNumber(renderPattern('ADPX/{FY}/{SEQ:4}', { FY: shortFy('2026-27'), SEQ: 1 })).ok).toBe(true)
  })

  it('every seeded series stays compliant at sequence 9999', () => {
    for (const pattern of ['ADP/{FY}/{SEQ:4}', 'ADPX/{FY}/{SEQ:4}', 'ADPC/{FY}/{SEQ:4}', 'ADPR/{FY}/{SEQ:4}', 'ADPS/{FY}/{SEQ:4}', 'ADPP/{FY}/{SEQ:4}']) {
      const n = renderPattern(pattern, { FY: shortFy('2026-27'), SEQ: 9999 })
      expect(validateInvoiceNumber(n), `${pattern} -> ${n}`).toEqual({ ok: true })
    }
  })
})
