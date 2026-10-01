import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'

/**
 * Integration tests against the real database. These prove the guarantees that
 * application code cannot provide — the Postgres triggers from migration
 * 20261001000001. Run with: npm run test:db
 */
const prisma = new PrismaClient()
let companyId = '', fyId = '', arId = '', revId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id
  arId = (await prisma.account.findFirstOrThrow({ where: { companyId, code: '1100' } })).id
  revId = (await prisma.account.findFirstOrThrow({ where: { companyId, code: '4020' } })).id
})
afterAll(async () => { await prisma.$disconnect() })

async function nextEntryNo() {
  const last = await prisma.journalEntry.findFirst({ where: { companyId, financialYearId: fyId }, orderBy: { entryNo: 'desc' } })
  return (last?.entryNo ?? 0) + 1
}

describe('seed', () => {
  it('created Adpedia with the verified identifiers', async () => {
    const c = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
    expect(c.gstin).toBe('32AAUCA9985H1ZX')
    expect(c.cin).toBe('U92190KL2021PTC068241')
    expect(c.tan).toBe('CHNA09808A')
    expect(c.stateCode).toBe('32')
    expect((c.registeredAddress as { line1: string }).line1).toContain('VIII/318')
  })

  it('seeded 60 ledger accounts, all system-locked', async () => {
    // 55 from docs/12, plus the five electronic-cash-ledger accounts in docs/46
    expect(await prisma.account.count({ where: { companyId } })).toBe(60)
    expect(await prisma.account.count({ where: { companyId, isSystem: false } })).toBe(0)
  })

  it('starts the invoice series at 26, continuing the legacy count', async () => {
    const s = await prisma.documentSeries.findFirstOrThrow({ where: { companyId, docType: 'TAX_INVOICE' } })
    expect(s.nextSeq).toBe(26)
    expect(s.pattern).toBe('ADP/{FY}/{SEQ:4}')
  })

  it('has LUTs for 2024-25 and 2025-26 but NOT the current year', async () => {
    const luts = await prisma.companyLut.findMany({ where: { companyId }, orderBy: { fyLabel: 'asc' } })
    expect(luts.map((l) => l.fyLabel)).toEqual(['2024-25', '2025-26'])
    expect(await prisma.companyLut.findFirst({ where: { companyId, fyLabel: '2026-27' } })).toBeNull()
  })
})

describe('🔴 trigger: every journal entry must balance', () => {
  it('accepts a balanced entry', async () => {
    const e = await prisma.journalEntry.create({
      data: {
        companyId, financialYearId: fyId, entryNo: await nextEntryNo(), date: new Date('2026-09-30'),
        narration: 'test — balanced', sourceType: 'MANUAL',
        lines: { create: [
          { accountId: arId, debit: '1000.00', credit: '0' },
          { accountId: revId, debit: '0', credit: '1000.00' },
        ]},
      },
    })
    expect(e.id).toBeTruthy()
  })

  it('REJECTS an entry that is off by one paisa', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          companyId, financialYearId: fyId, entryNo: await nextEntryNo(), date: new Date('2026-09-30'),
          narration: 'test — unbalanced', sourceType: 'MANUAL',
          lines: { create: [
            { accountId: arId, debit: '1000.00', credit: '0' },
            { accountId: revId, debit: '0', credit: '999.99' },
          ]},
        },
      }),
    ).rejects.toThrow(/unbalanced/i)
  })

  it('REJECTS an entry with no lines at all', async () => {
    await expect(
      prisma.journalEntry.create({
        data: { companyId, financialYearId: fyId, entryNo: await nextEntryNo(), date: new Date('2026-09-30'), narration: 'test — empty', sourceType: 'MANUAL' },
      }),
    ).rejects.toThrow(/no lines/i)
  })

  it('REJECTS a line carrying both a debit and a credit', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          companyId, financialYearId: fyId, entryNo: await nextEntryNo(), date: new Date('2026-09-30'),
          narration: 'test — two-sided', sourceType: 'MANUAL',
          lines: { create: [
            { accountId: arId, debit: '500.00', credit: '500.00' },
            { accountId: revId, debit: '0', credit: '0' },
          ]},
        },
      }),
    ).rejects.toThrow()
  })
})

describe('🔴 trigger: financial records are never hard-deleted', () => {
  it('REFUSES to delete a journal entry', async () => {
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { companyId, narration: 'test — balanced' } })
    await expect(prisma.journalEntry.delete({ where: { id: e.id } })).rejects.toThrow(/never hard-deleted/i)
  })

  it('REFUSES to delete an audit log row, and refuses to update one', async () => {
    const log = await prisma.auditLog.create({
      data: { companyId, entity: 'Test', entityId: 'x', action: 'CREATE' },
    })
    await expect(prisma.auditLog.update({ where: { id: log.id }, data: { action: 'UPDATE' } })).rejects.toThrow(/append-only/i)
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/never hard-deleted/i)
  })
})

describe('🔴 invoice numbers are unique per company', () => {
  it('rejects a duplicate number — the invoice-11 incident made impossible', async () => {
    const customer = await prisma.customer.create({
      data: { companyId, name: 'Test Client', billingAddress: {}, country: 'IN', stateCode: '32' },
    })
    const base = {
      companyId, financialYearId: fyId, customerId: customer.id, date: new Date('2026-09-30'),
      dueDate: new Date('2026-10-15'), taxMode: 'INTRA' as const, placeOfSupply: '32', seq: 99,
    }
    await prisma.invoice.create({ data: { ...base, number: 'ADP/26-27/0099' } })
    await expect(prisma.invoice.create({ data: { ...base, number: 'ADP/26-27/0099' } })).rejects.toThrow()
  })
})
