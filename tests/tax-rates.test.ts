import { describe, it, expect } from 'vitest'
import { Decimal } from '@/lib/money'
import { TDS_SECTIONS } from '../prisma/seed/tax-rates'
import { KERALA_PT_SLABS } from '../prisma/seed/payroll'
import { assertWithinConstitutionalCap, ANNUAL_PT_CAP } from '@/server/services/payroll/profession-tax'

const bySection = Object.fromEntries(TDS_SECTIONS.map((s) => [s.code, s]))

describe('TDS rates in force from 1 April 2025', () => {
  it('194J professional is 10% with a ₹50,000 annual threshold', () => {
    const s = bySection['194J']
    expect(s.rateCompany).toBe('10')
    expect(s.rateIndividualHuf).toBe('10')
    expect(s.thresholdAnnual).toBe('50000')   // FA 2025 raised it from ₹30,000
  })

  it('194J technical services is 2%, not 10%', () => {
    expect(bySection['194J-TS'].rateCompany).toBe('2')
  })

  it('🔴 194J director fees carry NO threshold', () => {
    // s.194J(1)(ba) — a sitting fee attracts TDS from the first rupee. Running it through
    // the ₹50,000 professional threshold under-deducts for the whole year.
    const s = bySection['194J-DIR']
    expect(s.thresholdAnnual).toBeNull()
    expect(s.thresholdSingle).toBeNull()
    expect(s.rateCompany).toBe('10')
  })

  it('🔴 194C splits 1% individual / 2% company, on either threshold', () => {
    const s = bySection['194C']
    expect(s.rateIndividualHuf).toBe('1')
    expect(s.rateCompany).toBe('2')
    expect(s.thresholdSingle).toBe('30000')
    expect(s.thresholdAnnual).toBe('100000')
  })

  it('🔴 194H is 2% — it was cut from 5% on 1 Oct 2024', () => {
    const s = bySection['194H']
    expect(s.rateCompany).toBe('2')
    expect(s.rateIndividualHuf).toBe('2')
    expect(s.thresholdAnnual).toBe('20000')   // FA 2025 raised it from ₹15,000
  })

  it('🔴 equipment rent is 2% while premises rent is 10%', () => {
    // a production company hires cameras and lighting constantly; billing those at the
    // 10% premises rate over-deducts fivefold
    expect(bySection['194I-A'].rateCompany).toBe('2')
    expect(bySection['194I-B'].rateCompany).toBe('10')
    expect(bySection['194I-A'].thresholdAnnual).toBe('600000')
    expect(bySection['194I-B'].thresholdAnnual).toBe('600000')
  })

  it('🔴 the no-PAN rate is 20% everywhere except 194Q, where s.206AA caps it at 5%', () => {
    for (const s of TDS_SECTIONS) {
      if (s.code === '194Q') { expect(s.rateNoPan).toBe('5'); continue }
      expect(s.rateNoPan).toBe('20')
    }
  })

  it('195 has no threshold — a chargeable sum is taxed from the first rupee', () => {
    const s = bySection['195']
    expect(s.thresholdAnnual).toBeNull()
    expect(s.returnForm).toBe('27Q')
  })

  it('routes each section to the right return form', () => {
    expect(bySection['192'].returnForm).toBe('24Q')        // salary
    expect(bySection['195'].returnForm).toBe('27Q')        // non-resident
    for (const s of TDS_SECTIONS) {
      if (s.code === '192' || s.code === '195') continue
      expect(s.returnForm).toBe('26Q')                     // everything else resident
    }
  })

  it('never states a rate above 20% for a resident section', () => {
    for (const s of TDS_SECTIONS) {
      if (s.code === '195') continue
      expect(Number(s.rateCompany)).toBeLessThanOrEqual(20)
      expect(Number(s.rateIndividualHuf)).toBeLessThanOrEqual(20)
    }
  })

  it('has no duplicate section codes', () => {
    const codes = TDS_SECTIONS.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('Kerala profession tax slabs', () => {
  it('🔴 tops out at exactly the Article 276(2) ceiling', () => {
    const top = Math.max(...KERALA_PT_SLABS.map((s) => Number(s.amount)))
    expect(new Decimal(top).mul(2).toString()).toBe(ANNUAL_PT_CAP.toString())
    expect(() => assertWithinConstitutionalCap(new Decimal(top))).not.toThrow()
  })

  it('refuses a table that would breach the ceiling', () => {
    expect(() => assertWithinConstitutionalCap(new Decimal('1300')))
      .toThrow(/Article 276/)
  })

  it('🔴 leaves no gap between bands', () => {
    // the published table is written in whole rupees (…11999, then 12000…). Any gap means
    // an employee whose half-year earnings land inside it is silently taxed at zero.
    const sorted = [...KERALA_PT_SLABS].sort((a, b) => Number(a.from) - Number(b.from))
    for (let i = 0; i < sorted.length - 1; i++) {
      const to = Number(sorted[i].to)
      const nextFrom = Number(sorted[i + 1].from)
      expect(nextFrom - to).toBe(1)
    }
  })

  it('starts at zero and ends unbounded', () => {
    const sorted = [...KERALA_PT_SLABS].sort((a, b) => Number(a.from) - Number(b.from))
    expect(sorted[0].from).toBe('0')
    expect(sorted[0].amount).toBe('0')
    expect(sorted.at(-1)!.to).toBeNull()
  })

  it('rises monotonically — a higher band never pays less', () => {
    const sorted = [...KERALA_PT_SLABS].sort((a, b) => Number(a.from) - Number(b.from))
    for (let i = 1; i < sorted.length; i++) {
      expect(Number(sorted[i].amount)).toBeGreaterThanOrEqual(Number(sorted[i - 1].amount))
    }
  })
})
