import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { Decimal } from '@/lib/money'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { recordGstFiling, listGstFilings, unrecordGstFiling, filedPeriods } from '@/server/services/tax/gst-filing'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import { postJournal } from '@/server/services/accounting/journal'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, customerId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
    gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id

  await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId, date: '2026-05-10',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('recording a filing', () => {
  it('snapshots the figures as filed', async () => {
    const row = await recordGstFiling(ctx, {
      returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-13', arn: 'AD320726001234A',
    })
    expect(row.status).toBe('FILED')
    expect(row.arn).toBe('AD320726001234A')
    // ₹1,00,000 taxable at 18% intra-state
    expect(new Decimal(row.outputTax.toString()).toString()).toBe('18000')
  })

  it('🔴 locks the period, because a change inside it would make the filed return wrong', async () => {
    const fy = await prisma.financialYear.findFirstOrThrow({
      where: { companyId: ctx.companyId, status: 'OPEN' },
    })
    expect(fy.lockedUpTo).not.toBeNull()
    expect(fy.lockedUpTo!.toISOString().slice(0, 10)).toBe('2026-06-30')

    await expect(postJournal(ctx, {
      date: new Date('2026-05-15'), narration: 'Late adjustment', sourceType: 'MANUAL',
      postings: [{ accountCode: '5500', debit: new Decimal('100') }, { accountCode: '1010', credit: new Decimal('100') }],
    })).rejects.toThrow(/locked/i)
  })

  it('still accepts a posting after the filed period', async () => {
    const e = await postJournal(ctx, {
      date: new Date('2026-07-15'), narration: 'Office supplies', sourceType: 'MANUAL',
      postings: [{ accountCode: '5500', debit: new Decimal('100') }, { accountCode: '1010', credit: new Decimal('100') }],
    })
    expect(e.id).toBeTruthy()
  })

  it('🔴 refuses to file the same return twice', async () => {
    await expect(recordGstFiling(ctx, {
      returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-20',
    })).rejects.toThrow(/already recorded as filed/)
  })

  it('rejects a malformed ARN rather than storing nonsense', async () => {
    await expect(recordGstFiling(ctx, {
      returnType: 'GSTR3B', periodLabel: '2026-Q1', filedOn: '2026-07-24', arn: 'nope',
    })).rejects.toThrow(/does not look like a GST ARN/)
  })

  it('refuses a period that is not a filing period for the year', async () => {
    await expect(recordGstFiling(ctx, {
      returnType: 'GSTR1', periodLabel: '2099-Q1', filedOn: '2026-07-13',
    })).rejects.toThrow(/not a filing period/)
  })
})

describe('🔴 the calendar stops nagging about what is filed', () => {
  it('marks the filed return done and leaves the other outstanding', async () => {
    const items = await complianceCalendar(ctx, new Date('2026-08-01'))
    const g1 = items.find((i) => i.id === 'gstr1-2026-Q1')!
    const g3b = items.find((i) => i.id === 'gstr3b-2026-Q1')!

    expect(g1.state).toBe('DONE')
    expect(g1.detail).toBe('Filed')
    expect(g3b.state).not.toBe('DONE')
  })

  it('exposes what is filed as a lookup set', async () => {
    const filed = await filedPeriods(ctx.companyId)
    expect(filed.has('GSTR1:2026-Q1')).toBe(true)
    expect(filed.has('GSTR3B:2026-Q1')).toBe(false)
  })
})

describe('undoing a filing record', () => {
  it('🔴 clears the record but deliberately leaves the period locked', async () => {
    const [row] = await listGstFilings(ctx)
    const res = await unrecordGstFiling(ctx, row.id, 'Recorded against the wrong quarter')
    expect(res.note).toMatch(/stays locked/)

    const fy = await prisma.financialYear.findFirstOrThrow({
      where: { companyId: ctx.companyId, status: 'OPEN' },
    })
    // the return may genuinely have been filed on the portal even if this record was wrong —
    // quietly reopening the month is how a filed return stops matching the books
    expect(fy.lockedUpTo).not.toBeNull()
  })

  it('demands a reason', async () => {
    const [row] = await listGstFilings(ctx)
    await expect(unrecordGstFiling(ctx, row.id, 'no')).rejects.toThrow(/Say why/)
  })
})
