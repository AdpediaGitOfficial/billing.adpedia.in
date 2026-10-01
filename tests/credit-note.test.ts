import { describe, it, expect } from 'vitest'
import { gstAdjustmentDeadline, canAdjustGst } from '@/server/services/invoicing/credit-note'

const iso = (d: Date) => d.toISOString().slice(0, 10)

describe('🔴 the s.34(2) deadline for adjusting GST', () => {
  it('is 30 November following the END of the financial year of supply', () => {
    // supply 15 May 2026 → FY 2026-27 → ends 31 Mar 2027 → deadline 30 Nov 2027
    expect(iso(gstAdjustmentDeadline(new Date('2026-05-15')))).toBe('2027-11-30')
  })

  it('🔴 puts a March supply in the SAME financial year, not the next', () => {
    // the trap: 15 March 2027 is FY 2026-27, so the deadline is 30 Nov 2027 — the same as a
    // May 2026 supply. Reading it as FY 2027-28 would give a whole extra year that does not
    // exist, and the shortfall only appears when the return is reconciled.
    expect(iso(gstAdjustmentDeadline(new Date('2027-03-15')))).toBe('2027-11-30')
  })

  it('rolls over on 1 April', () => {
    expect(iso(gstAdjustmentDeadline(new Date('2027-03-31')))).toBe('2027-11-30')
    expect(iso(gstAdjustmentDeadline(new Date('2027-04-01')))).toBe('2028-11-30')
  })

  it('allows a credit note raised inside the window', () => {
    expect(canAdjustGst(new Date('2026-05-15'), new Date('2027-11-30'))).toBe(true)
    expect(canAdjustGst(new Date('2026-05-15'), new Date('2026-06-01'))).toBe(true)
  })

  it('🔴 refuses the day after, with no grace', () => {
    // the note stays valid between the parties; the GST already paid simply cannot be
    // recovered. Nothing about the document looks different, which is why this is checked.
    expect(canAdjustGst(new Date('2026-05-15'), new Date('2027-12-01'))).toBe(false)
  })
})
