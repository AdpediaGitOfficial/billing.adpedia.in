import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'

/**
 * docs/95 — the ledger's second check covered the ENTRY, and a LINE could be changed behind it.
 */
const prisma = new PrismaClient()
let entryId = '', lineId = '', arId = '', cashId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow()
  const user = await prisma.user.findFirstOrThrow()
  const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })
  arId = (await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: '1100' } })).id
  cashId = (await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: '1010' } })).id
  const entry = await prisma.journalEntry.create({
    data: {
      companyId: company.id, financialYearId: fy.id, entryNo: 1, date: new Date('2026-11-01'),
      narration: 'fixture', sourceType: 'MANUAL', postedById: user.id,
      lines: { create: [
        { accountId: arId, debit: '100.00', credit: '0' },
        { accountId: cashId, debit: '0', credit: '100.00' },
      ] },
    },
    include: { lines: true },
  })
  entryId = entry.id
  lineId = entry.lines[0].id
})
afterAll(async () => { await prisma.$disconnect() })

const refused = (p: Promise<unknown>, re: RegExp) =>
  expect(p).rejects.toThrow(re)

describe('🔴 a posted journal line cannot be changed behind its entry', () => {
  it('still lets an entry and its balanced lines be posted in one transaction', async () => {
    const company = await prisma.company.findFirstOrThrow()
    const user = await prisma.user.findFirstOrThrow()
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })
    const e = await prisma.journalEntry.create({
      data: {
        companyId: company.id, financialYearId: fy.id, entryNo: 2, date: new Date('2026-11-02'),
        narration: 'balanced', sourceType: 'MANUAL', postedById: user.id,
        lines: { create: [
          { accountId: arId, debit: '5.00', credit: '0' }, { accountId: cashId, debit: '0', credit: '5.00' },
        ] },
      },
    })
    expect(e.entryNo).toBe(2)
  })

  it('🔴 refuses to delete a line', async () => {
    await refused(prisma.journalLine.delete({ where: { id: lineId } }), /never be hard-deleted|financial records are never/i)
  })

  it('🔴 refuses to change an amount', async () => {
    await refused(prisma.journalLine.update({ where: { id: lineId }, data: { debit: '999.00' } }), /never edited|rewrite/i)
  })

  it('🔴 refuses to move a line to another account', async () => {
    await refused(prisma.journalLine.update({ where: { id: lineId }, data: { accountId: cashId } }), /never edited|rewrite/i)
  })

  it('🔴 refuses to add a one-sided line to a posted entry, at commit', async () => {
    await refused(
      prisma.journalLine.create({ data: { journalEntryId: entryId, accountId: arId, debit: '1.00', credit: '0' } }),
      /unbalanced/i,
    )
  })

  it('refuses an entry whose lines do not balance, whatever the application said', async () => {
    const company = await prisma.company.findFirstOrThrow()
    const user = await prisma.user.findFirstOrThrow()
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })
    await refused(prisma.journalEntry.create({
      data: {
        companyId: company.id, financialYearId: fy.id, entryNo: 3, date: new Date('2026-11-03'),
        narration: 'skewed', sourceType: 'MANUAL', postedById: user.id,
        lines: { create: [{ accountId: arId, debit: '7.00', credit: '0' }, { accountId: cashId, debit: '0', credit: '6.00' }] },
      },
    }), /unbalanced/i)
  })

  it('leaves the fixture exactly as it was', async () => {
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entryId }, orderBy: { debit: 'desc' } })
    expect(lines.map((l) => [l.debit.toString(), l.credit.toString()])).toEqual([['100', '0'], ['0', '100']])
  })

  it('does not get in the way of attributing a line to a party', async () => {
    // the party/project columns are written by ON DELETE SET NULL, so they are not frozen
    const updated = await prisma.journalLine.update({ where: { id: lineId }, data: { narration: 'a note' } })
    expect(updated.narration).toBe('a note')
  })
})
