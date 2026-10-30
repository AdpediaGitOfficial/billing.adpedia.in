import { describe, it, expect } from 'vitest'
import { chartFor, equityRows } from '@/server/services/company/chart'
import type { Constitution } from '@prisma/client'

const ALL: Constitution[] = ['PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'LLP', 'PARTNERSHIP', 'PROPRIETORSHIP']
const codes = (c: Constitution) => equityRows(c).map((r) => r.code)
const named = (c: Constitution, code: string) => equityRows(c).find((r) => r.code === code)

describe('the equity section depends on who owns the entity — docs/82 §4', () => {
  it('a company has share capital and no drawings', () => {
    for (const c of ['PRIVATE_LIMITED', 'PUBLIC_LIMITED'] as const) {
      expect(named(c, '3000')!.name).toBe('Share Capital')
      expect(codes(c)).not.toContain('3300')
    }
  })

  it('a proprietorship has the opposite — capital and drawings, no share capital', () => {
    expect(named('PROPRIETORSHIP', '3000')!.name).toBe("Proprietor's Capital")
    expect(named('PROPRIETORSHIP', '3300')!.name).toBe('Drawings')
    expect(equityRows('PROPRIETORSHIP').map((r) => r.name)).not.toContain('Share Capital')
  })

  it('a firm has partners’ capital and partners’ drawings', () => {
    for (const c of ['LLP', 'PARTNERSHIP'] as const) {
      expect(named(c, '3000')!.name).toBe("Partners' Capital")
      expect(named(c, '3300')!.name).toBe("Partners' Drawings")
    }
  })

  /**
   * 🔴 The whole reason drawings is modelled this way.
   *
   * `profitAndLoss` reads INCOME and EXPENSE accounts only, so an equity contra cannot reach
   * it by construction. That is what lets a proprietor record rent, groceries and medical
   * bills in full — the complete money trail docs/82 §4 asks for — without moving taxable
   * profit by a paisa. Typed EXPENSE instead, household spending would understate the profit
   * actually declared, which is the one line that matters here.
   */
  it('🔴 drawings is EQUITY, so no P&L can ever see it', () => {
    for (const c of ['PROPRIETORSHIP', 'LLP', 'PARTNERSHIP'] as const) {
      expect(named(c, '3300')!.type).toBe('EQUITY')
      expect(named(c, '3300')!.subType).toBe('DRAWINGS')
    }
  })

  it('every constitution carries retained earnings and the current year', () => {
    for (const c of ALL) expect(codes(c)).toEqual(expect.arrayContaining(['3100', '3200']))
  })
})

describe('the chart itself', () => {
  /**
   * 🔴 GL 1010 used to be named "Axis Bank — Current 921020015185413" in the chart constant,
   * so every company created afterwards would have been born with another entity's bank
   * account number on its balance sheet.
   */
  it('does not carry one company’s bank account into another’s', () => {
    expect(chartFor().find((r) => r.code === '1010')!.name).toBe('Bank — Current')
    expect(JSON.stringify(chartFor())).not.toContain('921020015185413')
  })

  it('takes the bank label per company', () => {
    const chart = chartFor({ bankLabel: 'HDFC — Current 50200012345678' })
    expect(chart.find((r) => r.code === '1010')!.name).toBe('HDFC — Current 50200012345678')
  })

  it('has no duplicate codes, whichever constitution it is built for', () => {
    for (const c of ALL) {
      const all = chartFor({ constitution: c }).map((r) => r.code)
      expect(new Set(all).size, `duplicate code for ${c}`).toBe(all.length)
    }
  })

  it('every child names a parent that exists', () => {
    for (const c of ALL) {
      const chart = chartFor({ constitution: c })
      const present = new Set(chart.map((r) => r.code))
      for (const r of chart.filter((r) => r.parent)) {
        expect(present.has(r.parent!), `${r.code} points at missing parent ${r.parent}`).toBe(true)
      }
    }
  })
})
