import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal, ZERO } from '@/lib/money'
import { planSetOff, type SetOffInput } from '@/server/services/tax/gst-setoff-engine'

const D = (v: string | number) => new Decimal(v)

const input = (p: {
  igst?: string; cgst?: string; sgst?: string; rcm?: string; interest?: string; lateFee?: string
  cIgst?: string; cCgst?: string; cSgst?: string
  xIgst?: string; xCgst?: string; xSgst?: string; xOther?: string
}): SetOffInput => ({
  liability: {
    igst: D(p.igst ?? 0), cgst: D(p.cgst ?? 0), sgst: D(p.sgst ?? 0),
    rcm: D(p.rcm ?? 0), interest: D(p.interest ?? 0), lateFee: D(p.lateFee ?? 0),
  },
  credit: { igst: D(p.cIgst ?? 0), cgst: D(p.cCgst ?? 0), sgst: D(p.cSgst ?? 0) },
  cash: { igst: D(p.xIgst ?? 0), cgst: D(p.xCgst ?? 0), sgst: D(p.xSgst ?? 0), other: D(p.xOther ?? 0) },
})

describe('the order of utilisation — s.49(5) and rule 88A', () => {
  it('settles each head from its own credit first', () => {
    const p = planSetOff(input({ cgst: '9000', sgst: '9000', cCgst: '9000', cSgst: '9000' }))
    expect(p.credit.cgstToCgst.toString()).toBe('9000')
    expect(p.credit.sgstToSgst.toString()).toBe('9000')
    expect(p.cash.total.toString()).toBe('0')
    expect(p.shortfall.total.toString()).toBe('0')
  })

  it('sends IGST credit to the IGST liability before anything else — s.49(5)(a)', () => {
    const p = planSetOff(input({ igst: '5000', cgst: '5000', sgst: '5000', cIgst: '5000', cCgst: '5000', cSgst: '5000' }))
    expect(p.credit.igstToIgst.toString()).toBe('5000')
    expect(p.credit.igstToCgst.toString()).toBe('0')
    expect(p.credit.igstToSgst.toString()).toBe('0')
  })

  it('🔴 exhausts IGST credit before touching CGST or SGST credit — rule 88A', () => {
    // 18,000 of CGST+SGST liability, and credit in both pots. The IGST credit has nowhere
    // else to go, so it must be spent first even though own-head credit would cover.
    const p = planSetOff(input({ cgst: '9000', sgst: '9000', cIgst: '10000', cCgst: '9000', cSgst: '9000' }))
    expect(p.credit.igstToCgst.plus(p.credit.igstToSgst).toString()).toBe('10000')
    expect(p.creditClosing.igst.toString()).toBe('0')
    expect(p.credit.total.toString()).toBe('18000')
    // what is left over is own-head credit, which carries forward
    expect(p.creditClosing.cgst.plus(p.creditClosing.sgst).toString()).toBe('10000')
    expect(p.notes.join(' ')).toMatch(/Rule 88A/)
  })

  it('uses leftover CGST credit against the IGST liability, never against SGST — s.49(5)(b)', () => {
    const p = planSetOff(input({ igst: '4000', cgst: '1000', cCgst: '5000' }))
    expect(p.credit.cgstToCgst.toString()).toBe('1000')
    expect(p.credit.cgstToIgst.toString()).toBe('4000')
    expect(p.cash.total.toString()).toBe('0')
  })

  it('uses leftover SGST credit against the IGST liability — s.49(5)(c)', () => {
    const p = planSetOff(input({ igst: '4000', sgst: '1000', cSgst: '5000' }))
    expect(p.credit.sgstToSgst.toString()).toBe('1000')
    expect(p.credit.sgstToIgst.toString()).toBe('4000')
  })
})

describe('🔴 CGST credit may never discharge SGST — s.49(5)(e) and (f)', () => {
  it('demands cash for SGST while CGST credit sits idle', () => {
    // the failure the old total-against-total netting hid: 18,000 of credit against 18,000
    // of liability nets to nothing payable, and the portal still asks for 9,000 in cash
    const p = planSetOff(input({ cgst: '9000', sgst: '9000', cCgst: '18000', xSgst: '0' }))
    expect(p.credit.cgstToCgst.toString()).toBe('9000')
    expect(p.shortfall.sgst.toString()).toBe('9000')
    expect(p.creditClosing.cgst.toString()).toBe('9000')
    expect(p.notes.join(' ')).toMatch(/s\.49\(5\)\(e\)/)
  })

  it('demands cash for CGST while SGST credit sits idle', () => {
    const p = planSetOff(input({ cgst: '9000', sgst: '9000', cSgst: '18000' }))
    expect(p.shortfall.cgst.toString()).toBe('9000')
    expect(p.notes.join(' ')).toMatch(/s\.49\(5\)\(f\)/)
  })

  it('never emits a cross utilisation at all — the plan has no such field', () => {
    const p = planSetOff(input({ sgst: '5000', cCgst: '5000' }))
    expect(Object.keys(p.credit)).not.toContain('cgstToSgst')
    expect(p.credit.total.toString()).toBe('0')
  })
})

describe('🔴 where the remaining IGST credit is sent', () => {
  it('goes to the head that would otherwise need cash, not simply to CGST first', () => {
    // CGST 100 / SGST 100 of liability, with 100 of IGST credit and 100 of CGST credit.
    // Sending the IGST credit to CGST first strands the CGST credit — which can never reach
    // SGST — and leaves 100 of SGST to be funded in cash that was never due.
    const p = planSetOff(input({ cgst: '100', sgst: '100', cIgst: '100', cCgst: '100' }))
    expect(p.credit.igstToSgst.toString()).toBe('100')
    expect(p.credit.cgstToCgst.toString()).toBe('100')
    expect(p.shortfall.total.toString()).toBe('0')
  })

  it('and the mirror case, where the SGST pot is the full one', () => {
    const p = planSetOff(input({ cgst: '100', sgst: '100', cIgst: '100', cSgst: '100' }))
    expect(p.credit.igstToCgst.toString()).toBe('100')
    expect(p.credit.sgstToSgst.toString()).toBe('100')
    expect(p.shortfall.total.toString()).toBe('0')
  })

  it('splits across both heads when neither is covered', () => {
    const p = planSetOff(input({ cgst: '100', sgst: '100', cIgst: '150' }))
    expect(p.credit.igstToCgst.plus(p.credit.igstToSgst).toString()).toBe('150')
    expect(p.shortfall.cgst.plus(p.shortfall.sgst).toString()).toBe('50')
  })
})

describe('🔴 what credit can never pay', () => {
  it('funds reverse charge in cash however much credit is available', () => {
    const p = planSetOff(input({ rcm: '5000', cIgst: '500000', xIgst: '5000' }))
    expect(p.cashToRcm.toString()).toBe('5000')
    expect(p.credit.total.toString()).toBe('0')
    expect(p.notes.join(' ')).toMatch(/s\.2\(82\)/)
  })

  it('reports a shortfall for reverse charge rather than reaching for credit', () => {
    const p = planSetOff(input({ rcm: '5000', cIgst: '500000' }))
    expect(p.shortfall.igst.toString()).toBe('5000')
    expect(p.discharged.rcm.toString()).toBe('0')
  })

  it('funds interest and late fee in cash only', () => {
    const p = planSetOff(input({ interest: '150', lateFee: '100', cIgst: '99999', xOther: '250' }))
    expect(p.cash.other.toString()).toBe('250')
    expect(p.credit.total.toString()).toBe('0')
    expect(p.notes.join(' ')).toMatch(/interest, fee or penalty/)
  })

  it('clears the fixed late fee before the interest when the deposit is partial', () => {
    const p = planSetOff(input({ interest: '150', lateFee: '100', xOther: '100' }))
    expect(p.discharged.lateFee.toString()).toBe('100')
    expect(p.discharged.interest.toString()).toBe('0')
    expect(p.shortfall.other.toString()).toBe('150')
  })
})

describe('🔴 cash under one major head cannot pay another', () => {
  it('leaves IGST cash untouched by a CGST liability, and says to use PMT-09', () => {
    const p = planSetOff(input({ cgst: '9000', xIgst: '9000' }))
    expect(p.cash.cgst.toString()).toBe('0')
    expect(p.shortfall.cgst.toString()).toBe('9000')
    expect(p.cashClosing.igst.toString()).toBe('9000')
    expect(p.notes.join(' ')).toMatch(/PMT-09/)
  })

  it('pays reverse charge before the rest of the IGST head when cash is short', () => {
    // reverse charge has no other source — credit can never reach it, whereas the ordinary
    // IGST liability has already had the credit ledger applied to it
    const p = planSetOff(input({ igst: '5000', rcm: '3000', xIgst: '3000' }))
    expect(p.discharged.rcm.toString()).toBe('3000')
    expect(p.discharged.igst.toString()).toBe('0')
    expect(p.shortfall.igst.toString()).toBe('5000')
  })

  it('names every short head in one instruction', () => {
    const p = planSetOff(input({ igst: '100', cgst: '200', sgst: '300', interest: '40' }))
    const note = p.notes.find((n) => n.startsWith('A challan is needed'))!
    expect(note).toMatch(/IGST ₹100\.00/)
    expect(note).toMatch(/CGST ₹200\.00/)
    expect(note).toMatch(/SGST ₹300\.00/)
    expect(note).toMatch(/interest and fee ₹40\.00/)
  })
})

describe('the plan always adds up', () => {
  it('discharges exactly what the cash and credit together covered', () => {
    const p = planSetOff(input({
      igst: '10000', cgst: '9000', sgst: '9000', rcm: '1800', interest: '250',
      cIgst: '6000', cCgst: '4000', cSgst: '4000',
      xIgst: '10000', xCgst: '10000', xSgst: '10000', xOther: '250',
    }))
    expect(p.discharged.total.toString()).toBe(p.credit.total.plus(p.cash.total).toString())
    expect(p.shortfall.total.toString()).toBe('0')
  })

  it('holds under arbitrary liabilities and balances', () => {
    const amt = fc.integer({ min: 0, max: 500_000 }).map((n) => new Decimal(n))
    fc.assert(
      fc.property(fc.tuple(amt, amt, amt, amt, amt, amt, amt, amt, amt, amt, amt, amt, amt),
        ([i, c, s, r, int, fee, ci, cc, cs, xi, xc, xs, xo]) => {
          const p = planSetOff({
            liability: { igst: i, cgst: c, sgst: s, rcm: r, interest: int, lateFee: fee },
            credit: { igst: ci, cgst: cc, sgst: cs },
            cash: { igst: xi, cgst: xc, sgst: xs, other: xo },
          })

          // nothing is ever created: no balance goes negative, and nothing is overdrawn
          for (const v of [p.creditClosing.igst, p.creditClosing.cgst, p.creditClosing.sgst,
            p.cashClosing.igst, p.cashClosing.cgst, p.cashClosing.sgst, p.cashClosing.other]) {
            expect(v.gte(0)).toBe(true)
          }
          expect(p.credit.igstToIgst.plus(p.credit.igstToCgst).plus(p.credit.igstToSgst).lte(ci)).toBe(true)
          expect(p.credit.cgstToCgst.plus(p.credit.cgstToIgst).lte(cc)).toBe(true)
          expect(p.credit.sgstToSgst.plus(p.credit.sgstToIgst).lte(cs)).toBe(true)
          expect(p.cash.igst.lte(xi)).toBe(true)
          expect(p.cash.cgst.lte(xc)).toBe(true)
          expect(p.cash.sgst.lte(xs)).toBe(true)
          expect(p.cash.other.lte(xo)).toBe(true)

          // and nothing is discharged twice: per head, settled + still short = the liability
          expect(p.discharged.cgst.plus(p.shortfall.cgst).toString()).toBe(c.toString())
          expect(p.discharged.sgst.plus(p.shortfall.sgst).toString()).toBe(s.toString())
          expect(p.discharged.igst.plus(p.discharged.rcm).plus(p.shortfall.igst).toString()).toBe(i.plus(r).toString())
          expect(p.discharged.interest.plus(p.discharged.lateFee).plus(p.shortfall.other).toString())
            .toBe(int.plus(fee).toString())

          // 🔴 rule 88A: CGST or SGST credit used while IGST credit is still available
          const igstLeft = p.creditClosing.igst
          const ownUsed = p.credit.cgstToCgst.plus(p.credit.cgstToIgst)
            .plus(p.credit.sgstToSgst).plus(p.credit.sgstToIgst)
          if (ownUsed.gt(0)) expect(igstLeft.isZero()).toBe(true)

          // the journal this plan posts must balance
          const debits = p.discharged.total
          const credits = p.credit.total.plus(p.cash.total)
          expect(debits.toString()).toBe(credits.toString())
        }),
      { numRuns: 300 },
    )
  })

  it('does nothing at all with nothing to do', () => {
    const p = planSetOff(input({}))
    expect(p.discharged.total.toString()).toBe('0')
    expect(p.shortfall.total.toString()).toBe('0')
    expect(p.notes).toHaveLength(0)
    expect(p.cash.total.eq(ZERO)).toBe(true)
  })
})
