import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor, updateVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill, payBill } from '@/server/services/purchases/bill'
import { createExpense, listExpenses } from '@/server/services/purchases/expense'
import { cancelExpense, cancelBillPayment } from '@/server/services/accounting/corrections'
import { confirmPanCard } from '@/server/services/tax/pan-card'
import { uploadAttachment } from '@/server/services/storage/attachment'
import { listPasskeys, deletePasskey } from '@/server/services/auth/webauthn'
import { currentFinancialYear } from '@/server/services/accounting/period'
import type { RequestContext } from '@/server/context'

/**
 * docs/49 — the services that existed with nothing able to call them.
 *
 * The services were tested; what was missing was a caller. These tests cover what changed
 * when the callers arrived, and the one piece of behaviour that had to change with them.
 */

const prisma = new PrismaClient()
let ctx: RequestContext, vendorId = '', categoryId = ''

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  vendorId = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })).id
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: company.id } })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 a cancelled expense stays on the list, struck through', () => {
  it('lists it rather than hiding it', async () => {
    const e = await createExpense(ctx, {
      categoryId, date: '2026-08-05', description: 'Duplicate capture from the phone',
      taxableValue: '5000', gstRatePct: '18', gstMode: 'INTRA', paidFrom: 'BANK',
    })
    expect((await listExpenses(ctx)).some((x) => x.id === e.id)).toBe(true)

    await cancelExpense(ctx, e.id, 'Captured twice from the phone')

    // it used to be filtered out, which made a cancellation indistinguishable from a delete
    // in a system whose first rule is that nothing financial is deleted
    const rows = await listExpenses(ctx)
    const row = rows.find((x) => x.id === e.id)
    expect(row).toBeDefined()
    expect(row!.cancelledAt).not.toBeNull()
  })
})

describe('cancelling a bill payment', () => {
  it('reverses it and reopens the bill', async () => {
    const bill = await createBill(ctx, {
      vendorId, billNumber: 'EX/900', billDate: '2026-08-10',
      lines: [{ description: 'Subcontract', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })
    await approveBill(ctx, bill.id)
    const payment = await payBill(ctx, {
      billId: bill.id, date: '2026-08-20', amount: '10000', mode: 'NEFT',
    })

    await cancelBillPayment(ctx, payment.id, 'Paid against the wrong bill')

    const after = await prisma.billPayment.findUniqueOrThrow({ where: { id: payment.id } })
    expect(after.cancelledAt).not.toBeNull()

    // both entries stay in the journal — the payment and its reversal
    const entries = await prisma.journalEntry.findMany({
      where: { companyId: ctx.companyId, sourceType: 'BILL_PAYMENT', sourceId: payment.id },
    })
    expect(entries).toHaveLength(2)
    expect(entries.some((e) => e.reversalOfId !== null)).toBe(true)
  })

  it('refuses without a reason', async () => {
    const bill = await createBill(ctx, {
      vendorId, billNumber: 'EX/901', billDate: '2026-08-11',
      lines: [{ description: 'Subcontract', sacCode: '998314', quantity: '1', rate: '20000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })
    await approveBill(ctx, bill.id)
    const p = await payBill(ctx, { billId: bill.id, date: '2026-08-21', amount: '5000', mode: 'NEFT' })
    await expect(cancelBillPayment(ctx, p.id, 'oops')).rejects.toThrow()
  })
})

describe('🔴 editing a vendor keeps what was already established', () => {
  it('does not undo a confirmed PAN card when something else changes', async () => {
    await uploadAttachment(ctx, {
      kind: 'PAN_CARD', entityType: 'Vendor', entityId: vendorId,
      filename: 'pan.jpg', contentType: 'image/jpeg', bytes: JPEG,
    })
    await confirmPanCard(ctx, 'VENDOR', vendorId)

    await updateVendor(ctx, vendorId, {
      name: 'Exalture Software Lab Pvt Ltd', vendorType: 'SUBCONTRACTOR',
      country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F',
      defaultTdsSection: '194C', paymentTermDays: 30,
    })

    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })
    expect(v.name).toBe('Exalture Software Lab Pvt Ltd')
    expect(v.panEvidence).toBe('CARD_ON_FILE')   // the card still backs the same number
  })

  it('🔴 drops the confirmation when the number itself changes', async () => {
    // the card on file is evidence for the OLD number, and nobody has checked the new one
    await updateVendor(ctx, vendorId, {
      name: 'Exalture Software Lab Pvt Ltd', vendorType: 'SUBCONTRACTOR',
      country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AAACE9999E',
      defaultTdsSection: '194C', paymentTermDays: 30,
    })
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })
    expect(v.panEvidence).toBe('DECLARED')
    expect(v.panVerified).toBe(true)             // still furnished, so still not 20%
  })

  it('records what the PAN was before the edit', async () => {
    const log = await prisma.auditLog.findFirst({
      where: { companyId: ctx.companyId, entity: 'Vendor', entityId: vendorId, action: 'UPDATE' },
      orderBy: { at: 'desc' },
    })
    expect(JSON.stringify(log!.before)).toContain('AABCE1234F')
    expect(JSON.stringify(log!.after)).toContain('AAACE9999E')
  })
})

describe('🔴 a passkey can be revoked', () => {
  it('removes only the caller’s own, and refuses one that is not theirs', async () => {
    // a passkey left on a lost phone kept working: listPasskeys and deletePasskey existed
    // with nothing able to call them, and the settings screen showed only a count
    const other = await prisma.user.create({
      data: { email: 'someone.else@adpedia.local', name: 'Someone Else', passwordHash: 'x' },
    })
    const mine = await prisma.passkey.create({ data: {
      userId: ctx.userId, credentialId: 'cred-mine', publicKey: Buffer.from('k'),
      counter: 0, label: 'iPhone', transports: [],
    } })
    const theirs = await prisma.passkey.create({ data: {
      userId: other.id, credentialId: 'cred-theirs', publicKey: Buffer.from('k'),
      counter: 0, label: 'Their laptop', transports: [],
    } })

    expect((await listPasskeys(ctx)).map((p) => p.id)).toEqual([mine.id])

    await expect(deletePasskey(ctx, theirs.id)).rejects.toThrow(/not found/)
    await deletePasskey(ctx, mine.id)
    expect(await listPasskeys(ctx)).toHaveLength(0)
    expect(await prisma.passkey.findUnique({ where: { id: theirs.id } })).not.toBeNull()
  })
})

describe('🔴 the financial year we are standing in', () => {
  it('is the one covering today, not the newest one on file', async () => {
    // creating next year's row early is normal — the document series for it have to exist
    // before April, and numbering refuses without them. Twenty-five screens asked for "the
    // newest OPEN year" instead, so the moment that row appeared the dashboard, the GST
    // position, the PAN register and the calendar all jumped to an empty future year.
    const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
    await prisma.financialYear.create({ data: {
      companyId: company.id, label: '2030-31',
      startsOn: new Date('2030-04-01'), endsOn: new Date('2031-03-31T23:59:59Z'),
    } })

    const fy = await currentFinancialYear(company.id, new Date('2026-10-02'))
    expect(fy!.label).toBe('2026-27')
  })

  it('falls back to the newest open year when none covers the date', async () => {
    const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
    const fy = await currentFinancialYear(company.id, new Date('2035-01-01'))
    expect(fy!.label).toBe('2030-31')
  })

  it('skips a year that covers today but has been closed', async () => {
    // standing inside a closed year, the place to work is the next open one
    const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
    await prisma.financialYear.update({
      where: { companyId_label: { companyId: company.id, label: '2026-27' } },
      data: { status: 'CLOSED' },
    })
    const fy = await currentFinancialYear(company.id, new Date('2026-10-02'))
    expect(fy!.label).toBe('2030-31')

    await prisma.financialYear.update({
      where: { companyId_label: { companyId: company.id, label: '2026-27' } },
      data: { status: 'OPEN' },
    })
  })
})

describe('🔴 nothing asks for "the newest open financial year" any more', () => {
  it('has no raw lookup left in the source', async () => {
    // docs/49 swept twenty-five call sites with a regex, and it missed two that used the
    // `companyId,` shorthand — one of which took the whole GST page down in docs/51 once a
    // future year existed. A grep is a cheaper guard than another render.
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.tsx?$/.test(p)) out.push(p)
      }
      return out
    }

    const offenders = walk('src')
      // period.ts holds the fallback itself; close.ts reopens a year by id
      .filter((f) => !f.endsWith('accounting/period.ts') && !f.endsWith('accounting/close.ts'))
      .filter((f) => /financialYear\.findFirst(OrThrow)?\(\{[^}]*status: 'OPEN'/s.test(readFileSync(f, 'utf8')))

    expect(offenders).toEqual([])
  })
})
