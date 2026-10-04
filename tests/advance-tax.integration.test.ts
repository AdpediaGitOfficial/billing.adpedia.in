import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import {
  setTaxEstimate, currentEstimate, recordAdvanceTax, advanceTaxPosition, listAdvanceTax,
} from '@/server/services/tax/advance-tax'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

/** docs/71 — the company's own advance tax, and the s.234C provisos. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', fyId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
const balance = async (code: string) => (await accountLedger(ctx, code, PERIOD))!.account.closing.toFixed(2)
const at = (by: 'JUN' | 'SEP' | 'DEC' | 'MAR', p: Awaited<ReturnType<typeof advanceTaxPosition>>) =>
  p.instalments.find((i) => i.by === by)!

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id
})
afterAll(async () => { await prisma.$disconnect() })

/**
 * 🔴 Absent, not zero.
 *
 * Every figure that depends on the liability would compute to 0.00 against a liability of
 * zero, and "shortfall ₹0.00" reads as "nothing is owed" — the opposite of what is true, which
 * is that nobody has worked it out.
 */
describe('🔴 before the CA has given an estimate', () => {
  it('reports the dates and says plainly that nothing can be computed', async () => {
    const p = await advanceTaxPosition(ctx, fyId, new Date('2027-01-01'))
    expect(p.estimate).toBeNull()
    expect(p.instalments).toHaveLength(4)
    expect(p.instalments.map((i) => i.dueOn.toISOString().slice(0, 10)))
      .toEqual(['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15'])
    expect(p.interestSoFar.toFixed(2)).toBe('0.00')
    expect(p.notes.join(' ')).toMatch(/No estimate/)
    expect(p.notes.join(' ')).toMatch(/taxable income is not book profit/)
  })

  it('refuses an estimate with no source, because nobody can derive it from the books', async () => {
    await expect(setTaxEstimate(ctx, { financialYearId: fyId, estimatedAnnualTax: '400000' }))
      .rejects.toThrow(/where the estimate came from/)
  })
})

describe('the estimate', () => {
  it('is superseded, never edited', async () => {
    await setTaxEstimate(ctx, { financialYearId: fyId, estimatedAnnualTax: '400000', source: 'R Menon & Co, interim' })
    await setTaxEstimate(ctx, { financialYearId: fyId, estimatedAnnualTax: '600000', source: 'R Menon & Co, revised after Q2' })

    const live = await currentEstimate(companyId, fyId)
    expect(live!.estimatedAnnualTax.toString()).toBe('600000')

    const all = await prisma.companyTaxEstimate.findMany({ where: { companyId, financialYearId: fyId } })
    expect(all).toHaveLength(2)
    expect(all.filter((e) => e.supersededAt === null)).toHaveLength(1)
  })
})

describe('an instalment paid', () => {
  it('🔴 is an asset, not an expense', async () => {
    const before = await balance('1350')
    await recordAdvanceTax(ctx, {
      paidOn: '2026-06-14', amount: '90000', bsrCode: '0510308', challanSerial: '00011',
    })
    expect(Number(await balance('1350'))).toBeCloseTo(Number(before) + 90000, 2)

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, sourceType: 'ADVANCE_TAX' },
      include: { lines: { include: { account: true } } },
    })
    // nothing of it reached the P&L
    expect(entry.lines.every((l) => l.account.type !== 'EXPENSE')).toBe(true)
  })

  it('carries a constructed CIN, in the OLTAS shape', async () => {
    const [p] = await listAdvanceTax(ctx, fyId)
    // BSR(7) + DDMMYYYY + serial(5)
    expect(p.cin).toBe('0510308' + '14' + '06' + '2026' + '00011')
  })

  it('refuses a BSR code that is not seven digits', async () => {
    await expect(recordAdvanceTax(ctx, {
      paidOn: '2026-06-14', amount: '1000', bsrCode: '12345', challanSerial: '1',
    })).rejects.toThrow(/BSR code must be 7 digits/)
  })
})

/**
 * 🔴 The provisos to s.234C(1): 12% by 15 June and 36% by 15 September forgive the INTEREST on
 * a near miss, for those two instalments only. The shortfall still has to be made up.
 */
describe('🔴 s.234C', () => {
  it('charges nothing when the June payment clears 12%, though it is short of 15%', async () => {
    // liability 600,000 → 15% is 90,000 and the harbour is 72,000. 90,000 is paid, so exactly met.
    const p = await advanceTaxPosition(ctx, fyId, new Date('2026-07-01'))
    const jun = at('JUN', p)
    expect(jun.required.toFixed(2)).toBe('90000.00')
    expect(jun.safeHarbour.toFixed(2)).toBe('72000.00')
    expect(jun.paid.toFixed(2)).toBe('90000.00')
    expect(jun.shortfall.toFixed(2)).toBe('0.00')
    expect(jun.interest.toFixed(2)).toBe('0.00')
  })

  /**
   * 🔴 Paid ON OR BEFORE the due date. A payment made on 20 September does not count towards
   * September's instalment at all — it counts towards December's, and September's interest is
   * charged in full regardless.
   */
  it('does not count a payment made after the date towards that instalment', async () => {
    await recordAdvanceTax(ctx, {
      paidOn: '2026-09-20', amount: '180000', bsrCode: '0510308', challanSerial: '00012',
    })
    const p = await advanceTaxPosition(ctx, fyId, new Date('2026-10-01'))
    const sep = at('SEP', p)
    expect(sep.paid.toFixed(2)).toBe('90000.00')          // only June's
    expect(sep.required.toFixed(2)).toBe('270000.00')     // 45% of 600,000
    expect(sep.shortfall.toFixed(2)).toBe('180000.00')
    // 180,000 short, below the 216,000 harbour, so 1% × 3 months
    expect(sep.withinSafeHarbour).toBe(false)
    expect(sep.interest.toFixed(2)).toBe('5400.00')

    const dec = at('DEC', p)
    expect(dec.paid.toFixed(2)).toBe('270000.00')         // June's and the late one
    expect(dec.passed).toBe(false)
    expect(dec.interest.toFixed(2)).toBe('0.00')          // not yet due
  })

  it('🔴 forgives the interest inside the proviso while still showing the shortfall', async () => {
    // a second year, so the figures stand alone
    const fy = await prisma.financialYear.upsert({
      where: { companyId_label: { companyId, label: '2027-28' } },
      update: {},
      create: {
        companyId, label: '2027-28', status: 'OPEN',
        startsOn: new Date(Date.UTC(2027, 3, 1)), endsOn: new Date(Date.UTC(2028, 2, 31, 23, 59, 59)),
      },
    })
    await setTaxEstimate(ctx, { financialYearId: fy.id, estimatedAnnualTax: '1000000', source: 'R Menon & Co' })
    // 130,000 by 15 June: short of 150,000 (15%) but above 120,000 (12%)
    await recordAdvanceTax(ctx, {
      paidOn: '2027-06-10', amount: '130000', bsrCode: '0510308', challanSerial: '00021',
    })

    const p = await advanceTaxPosition(ctx, fy.id, new Date('2027-07-01'))
    const jun = at('JUN', p)
    expect(jun.shortfall.toFixed(2)).toBe('20000.00')
    expect(jun.withinSafeHarbour).toBe(true)
    expect(jun.interest.toFixed(2)).toBe('0.00')
    expect(p.notes.join(' ')).toMatch(/proviso to s.234C\(1\)/)
  })

  it('charges one month, not three, on the final instalment', async () => {
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2027-28' } })
    const p = await advanceTaxPosition(ctx, fy.id, new Date('2028-03-20'))
    const mar = at('MAR', p)
    expect(mar.required.toFixed(2)).toBe('1000000.00')
    expect(mar.shortfall.toFixed(2)).toBe('870000.00')
    // 1% for ONE month, where the earlier instalments get three
    expect(mar.interest.toFixed(2)).toBe('8700.00')
    // and three on December's: 750,000 required, 130,000 paid, 620,000 short
    const dec = at('DEC', p)
    expect(dec.shortfall.toFixed(2)).toBe('620000.00')
    expect(dec.interest.toFixed(2)).toBe('18600.00')
  })
})

/** 🔴 What the books say is context for the conversation, and is never the taxable income. */
describe('profit before tax', () => {
  it('is reported separately from the estimate, and is not used to derive it', async () => {
    const p = await advanceTaxPosition(ctx, fyId, new Date('2027-01-01'))
    expect(p.estimate!.amount.toFixed(2)).toBe('600000.00')
    // present as its own figure; nothing above is computed from it
    expect(p.profitBeforeTax === null || typeof p.profitBeforeTax.toFixed === 'function').toBe(true)
  })
})
