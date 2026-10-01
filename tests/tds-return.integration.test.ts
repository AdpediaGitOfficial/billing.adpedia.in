import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { createChallan, outstandingDeductions } from '@/server/services/tax/tds-challan'
import { buildTdsReturn, tdsReturnToCsv } from '@/server/services/tax/tds-return'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let exalture = '', noPan = ''
const DATE = '2026-08-10'

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  exalture = (await createVendor(ctx, { name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C' })).id
  noPan    = (await createVendor(ctx, { name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', defaultTdsSection: '194J' })).id

  const line = (rate: string) => [{ description: 'Work', sacCode: '998314', quantity: '1', rate, gstRatePct: '18', expenseAccountCode: '5220' }]
  for (const [vendorId, num, rate] of [[exalture, 'EX/001', '200000'], [exalture, 'EX/002', '100000'], [noPan, 'MU/001', '60000']] as const) {
    const b = await createBill(ctx, { vendorId, billNumber: num, billDate: DATE, lines: line(rate) })
    await approveBill(ctx, b.id)
  }
})
afterAll(async () => { await prisma.$disconnect() })

describe('what is outstanding', () => {
  it('lists every unlinked deduction with its due date', async () => {
    const rows = await outstandingDeductions(ctx)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.dueOn.toISOString().slice(0, 10) === '2026-09-07')).toBe(true)
    expect(rows.find((r) => r.deducteeName === 'Maneesh Unnikuttan')!.tdsAmount.toFixed(2)).toBe('12000.00')  // 20% of 60,000
    expect(rows.find((r) => r.deducteeName === 'Maneesh Unnikuttan')!.panVerified).toBe(false)
  })
})

describe('challans', () => {
  it('rejects a malformed BSR code or serial', async () => {
    const rows = await outstandingDeductions(ctx)
    const ids = rows.filter((r) => r.sectionCode === '194C').map((r) => r.id)
    await expect(createChallan(ctx, { sectionCode: '194C', quarter: 2, deductionIds: ids, bsrCode: '12345', challanSerial: '1', depositedOn: '2026-09-05' }))
      .rejects.toThrow(/BSR code must be 7 digits/)
  })

  it('🔴 refuses to mix sections on one challan', async () => {
    const rows = await outstandingDeductions(ctx)
    await expect(createChallan(ctx, { sectionCode: '194C', quarter: 2, deductionIds: rows.map((r) => r.id), bsrCode: '0510308', challanSerial: '00001', depositedOn: '2026-09-05' }))
      .rejects.toThrow(/A challan covers one section/)
  })

  it('creates the challan, links the deductions and posts to the ledger', async () => {
    const rows = await outstandingDeductions(ctx)
    const ids = rows.filter((r) => r.sectionCode === '194C').map((r) => r.id)
    const challan = await createChallan(ctx, { sectionCode: '194C', quarter: 2, deductionIds: ids, bsrCode: '0510308', challanSerial: '00001', depositedOn: '2026-09-05' })

    expect(challan.amount.toString()).toBe('6000')          // 2% of 200,000 + 2% of 100,000
    expect(challan.cin).toBe('0510308202609050000100001'.slice(0, 7) + '20260905' + '00001')

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'TDS_CHALLAN', sourceId: challan.id }, include: { lines: { include: { account: true } } },
    })
    const by = Object.fromEntries(entry.lines.map((l) => [l.account.code, (Number(l.debit) || Number(l.credit)).toFixed(2)]))
    expect(by['2230']).toBe('6000.00')   // TDS payable — 194C, cleared
    expect(by['1010']).toBe('6000.00')   // bank

    expect(await prisma.tdsDeduction.count({ where: { challanId: challan.id } })).toBe(2)
    expect((await outstandingDeductions(ctx))).toHaveLength(1)   // only the 194J one left
  })

  it('refuses to put a deduction on a second challan', async () => {
    const used = await prisma.tdsDeduction.findFirstOrThrow({ where: { companyId: ctx.companyId, challanId: { not: null } } })
    await expect(createChallan(ctx, { sectionCode: '194C', quarter: 2, deductionIds: [used.id], bsrCode: '0510308', challanSerial: '00002', depositedOn: '2026-09-05' }))
      .rejects.toThrow(/already on a challan/)
  })

  it('posts interest and late fee to expense, not to the TDS liability', async () => {
    const rows = await outstandingDeductions(ctx)
    const challan = await createChallan(ctx, {
      sectionCode: '194J', quarter: 2, deductionIds: rows.map((r) => r.id),
      bsrCode: '0510308', challanSerial: '00003', depositedOn: '2026-11-20',
      interest: '360', lateFee: '200',
    })
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'TDS_CHALLAN', sourceId: challan.id }, include: { lines: { include: { account: true } } },
    })
    const tdsLine = entry.lines.find((l) => l.account.code === '2220')!
    const bank = entry.lines.find((l) => l.account.code === '1010')!
    const expense = entry.lines.filter((l) => l.account.code === '5500')
    expect(tdsLine.debit.toString()).toBe('12000')
    expect(expense.reduce((a, l) => a + Number(l.debit), 0)).toBe(560)
    expect(bank.credit.toString()).toBe('12560')   // the whole outflow
  })
})

describe('🔴 the pre-flight validator', () => {
  it('blocks a return where a deductee has no PAN', async () => {
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    expect(r.readyToFile).toBe(false)
    const noPanIssue = r.issues.find((i) => i.code === 'NO_PAN')
    expect(noPanIssue).toBeTruthy()
    expect(noPanIssue!.severity).toBe('error')
    expect(noPanIssue!.message).toMatch(/Maneesh Unnikuttan.*20%/)
  })

  it('marks a PAN-less deductee with the higher-rate reason code', async () => {
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    const row = r.deductees.find((d) => d.deducteeName === 'Maneesh Unnikuttan')!
    expect(row.reasonCode).toBe('C')
    expect(row.ratePct.toFixed(2)).toBe('20.00')
    expect(r.deductees.find((d) => d.deducteeName === 'Exalture Software Lab')!.reasonCode).toBeNull()
  })

  it('flags a late deposit as a warning with the interest consequence', async () => {
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    const late = r.issues.find((i) => i.code === 'LATE_DEPOSIT')
    expect(late).toBeTruthy()
    expect(late!.severity).toBe('warning')
    expect(late!.message).toMatch(/s\.201\(1A\)/)
  })

  it('reconciles each challan against the deductions linked to it', async () => {
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    expect(r.challans.every((c) => c.reconciles)).toBe(true)
    expect(r.issues.find((i) => i.code === 'CHALLAN_MISMATCH')).toBeUndefined()
    expect(r.totals.tdsDeducted.toFixed(2)).toBe(r.totals.challanTotal.toFixed(2))
  })

  it('catches a challan that no longer reconciles', async () => {
    const c = await prisma.tdsChallan.findFirstOrThrow({ where: { challanSerial: '00001' } })
    await prisma.tdsChallan.update({ where: { id: c.id }, data: { amount: '9999' } })
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    const mismatch = r.issues.find((i) => i.code === 'CHALLAN_MISMATCH')
    expect(mismatch).toBeTruthy()
    expect(mismatch!.message).toMatch(/RPU will reject this/)
    await prisma.tdsChallan.update({ where: { id: c.id }, data: { amount: '6000' } })
  })

  it('computes the s.234E fee when filed late', async () => {
    const r = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-11-20'))
    expect(r.dueOn.toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(r.lateFee!.days).toBe(20)
    expect(r.lateFee!.fee.toFixed(2)).toBe('4000.00')
    expect(r.issues.find((i) => i.code === 'LATE_FILING')).toBeTruthy()
  })
})

describe('forms are separated by section', () => {
  it('26Q excludes salary and non-resident deductions', async () => {
    const q = await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15'))
    expect(q.deductees.every((d) => d.sectionCode !== '192' && d.sectionCode !== '195')).toBe(true)
    const salary = await buildTdsReturn(ctx, '24Q', '2026-27', 2, new Date('2026-10-15'))
    expect(salary.deductees).toHaveLength(0)
    expect(salary.readyToFile).toBe(false)   // nothing to file is not "ready"
  })
})

describe('CSV export for the CA', () => {
  it('carries deductees, challans, totals and the issues', async () => {
    const csv = tdsReturnToCsv(await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15')))
    for (const section of ['# deductees', '# challans', '# totals', '# issues']) {
      expect(csv, `missing ${section}`).toContain(section)
    }
    expect(csv).toContain('CHNA09808A')                  // the TAN
    expect(csv).toContain('not an FVU file')
    expect(csv).toContain('Pre-flight,FAILED')
    expect(csv).toContain('AABCE1234F')                  // Exalture's PAN
    expect(csv).toContain('0510308')                     // BSR code
  })

  it('quotes a name containing a comma', async () => {
    await prisma.vendor.update({ where: { id: exalture }, data: { name: 'Exalture Software Lab, LLP' } })
    const csv = tdsReturnToCsv(await buildTdsReturn(ctx, '26Q', '2026-27', 2, new Date('2026-10-15')))
    expect(csv).toContain('"Exalture Software Lab, LLP"')
  })
})
