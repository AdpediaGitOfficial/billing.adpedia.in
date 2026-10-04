import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { recordRocDates, rocYears } from '@/server/services/compliance/roc'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import { recordAdvanceTax } from '@/server/services/tax/advance-tax'
import { cancelAdvanceTaxPayment } from '@/server/services/accounting/corrections'
import { accountLedger } from '@/server/services/reports/ledger'
import type { RequestContext } from '@/server/context'

/** docs/72 — the AGM, the two forms that run from it, and the cancellation docs/71 left open. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', fy2526 = ''
const item = (items: Awaited<ReturnType<typeof complianceCalendar>>, id: string) => items.find((i) => i.id === id)!

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fy2526 = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2025-26' } })).id
})
afterAll(async () => { await prisma.$disconnect() })

/**
 * 🔴 The ROC obligations are about the year that has ENDED.
 *
 * The AGM for FY 2026-27 is held in 2027; what is live in October 2026 is the one for 2025-26,
 * which was due on 30 September 2026. Keying these off the current financial year shows a date
 * a year away and omits the one already late.
 */
describe('🔴 which year the registrar is asking about', () => {
  it('reads the completed year, not the one we are in', async () => {
    const items = await complianceCalendar(ctx, new Date('2026-10-05'))
    const agm = item(items, 'agm')
    expect(agm.title).toContain('2025-26')
    expect(agm.dueOn.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(agm.state).toBe('OVERDUE')
  })
})

describe('🔴 a form cannot be filed before the meeting it reports', () => {
  it('refuses an AOC-4 date with no AGM behind it', async () => {
    await expect(recordRocDates(ctx, { financialYearId: fy2526, aoc4FiledOn: '2026-10-20' }))
      .rejects.toThrow(/Record the AGM first/)
  })

  it('refuses an AGM dated before the year it reports on ended', async () => {
    await expect(recordRocDates(ctx, { financialYearId: fy2526, agmHeldOn: '2026-02-01' }))
      .rejects.toThrow(/did not exist yet/)
  })

  it('refuses a filing dated before the meeting', async () => {
    await recordRocDates(ctx, { financialYearId: fy2526, agmHeldOn: '2026-08-15', agmSource: 'Minutes, signed' })
    await expect(recordRocDates(ctx, { financialYearId: fy2526, aoc4FiledOn: '2026-08-01' }))
      .rejects.toThrow(/cannot be filed before the AGM/)
  })
})

/**
 * 🔴 Thirty and sixty days from the MEETING, not from its deadline.
 *
 * An AGM held on 15 August makes AOC-4 due on 14 September — six weeks before the 30 October
 * anybody assuming a 30 September meeting would have written down.
 */
describe('🔴 the forms run from the meeting', () => {
  it('moves both deadlines with the date the AGM was actually held', async () => {
    const items = await complianceCalendar(ctx, new Date('2026-10-05'))
    expect(item(items, 'agm').state).toBe('DONE')
    expect(item(items, 'aoc4').dueOn.toISOString().slice(0, 10)).toBe('2026-09-14')
    expect(item(items, 'mgt7').dueOn.toISOString().slice(0, 10)).toBe('2026-10-14')
  })

  it('charges ₹100 a day per form, and says how much so far', async () => {
    const items = await complianceCalendar(ctx, new Date('2026-10-05'))
    // AOC-4 was due 14 September; 21 days late by 5 October
    expect(item(items, 'aoc4').penalty).toMatch(/2,100/)
    expect(item(items, 'aoc4').state).toBe('OVERDUE')
  })

  it('clears once the filing is recorded, because nothing else can clear it', async () => {
    await recordRocDates(ctx, { financialYearId: fy2526, aoc4FiledOn: '2026-09-10' })
    const items = await complianceCalendar(ctx, new Date('2026-10-05'))
    expect(item(items, 'aoc4').state).toBe('DONE')
    expect(item(items, 'aoc4').detail).toMatch(/Filed on 2026-09-10/)
    // and the penalty stops being quoted as a running total
    expect(item(items, 'aoc4').penalty).not.toMatch(/so far/)
  })
})

describe('without a meeting on record', () => {
  it('points at the meeting rather than the form', async () => {
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2025-26' } })
    await prisma.financialYear.update({
      where: { id: fy.id }, data: { agmHeldOn: null, aoc4FiledOn: null, mgt7FiledOn: null },
    })
    const items = await complianceCalendar(ctx, new Date('2026-10-05'))
    expect(item(items, 'agm').state).toBe('OVERDUE')
    // 🔴 a company cannot file AOC-4 before its AGM, so this is not yet an obligation
    expect(item(items, 'aoc4').state).toBe('NOT_APPLICABLE')
    expect(item(items, 'aoc4').detail).toMatch(/Record the meeting first/)
  })
})

describe('rocYears', () => {
  it('offers every year that has ended, newest first', async () => {
    const years = await rocYears(ctx, new Date('2026-10-05'))
    expect(years[0].label).toBe('2025-26')
    expect(years[0].agmLimit.toISOString().slice(0, 10)).toBe('2026-09-30')
  })
})

/** docs/72 — the member docs/71 modelled for and did not write. */
describe('cancelling an advance-tax payment', () => {
  it('reverses the entry and leaves the challan on file', async () => {
    const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }
    const balance = async () => (await accountLedger(ctx, '1350', PERIOD))!.account.closing.toFixed(2)

    const before = await balance()
    const p = await recordAdvanceTax(ctx, {
      paidOn: '2026-06-12', amount: '50000', bsrCode: '0510308', challanSerial: '00031',
    })
    expect(Number(await balance())).toBeCloseTo(Number(before) + 50000, 2)

    await cancelAdvanceTaxPayment(ctx, p.id, 'Challan belonged to another company', new Date('2026-06-20'))
    expect(Number(await balance())).toBeCloseTo(Number(before), 2)

    const after = await prisma.advanceTaxPayment.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.cancelledAt).not.toBeNull()
    expect(after.cancelReason).toMatch(/another company/)
  })

  it('refuses twice, and demands a reason', async () => {
    const p = await recordAdvanceTax(ctx, {
      paidOn: '2026-06-13', amount: '1000', bsrCode: '0510308', challanSerial: '00032',
    })
    await expect(cancelAdvanceTaxPayment(ctx, p.id, ' ', new Date('2026-06-20'))).rejects.toThrow()
    await cancelAdvanceTaxPayment(ctx, p.id, 'Entered twice from the same counterfoil', new Date('2026-06-20'))
    await expect(cancelAdvanceTaxPayment(ctx, p.id, 'Again', new Date('2026-06-20')))
      .rejects.toThrow(/already cancelled/)
  })
})
