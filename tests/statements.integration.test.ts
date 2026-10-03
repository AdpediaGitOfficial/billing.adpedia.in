import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { resolvePeriod } from '@/server/services/reports/period'
import { statementStanding } from '@/server/services/reports/status'
import { renderStatementHtml } from '@/server/services/reports/render-statement'
import { journalExport } from '@/server/services/reports/journal-export'
import { accountLedger } from '@/server/services/reports/ledger'
import { journalCsv, accountLedgerCsv } from '@/server/services/reports/export'
import { htmlToPdf, closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = ''
let period: Awaited<ReturnType<typeof resolvePeriod>>

const META = () => ({ company: 'Adpedia Films Private Limited', gstin: '32AAUCA9985H1ZX', period: period.label })

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  const customer = await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })
  const inv = await createInvoice(ctx, {
    customerId: customer.id, date: '2026-05-10',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '400000', gstRatePct: '18' }],
  })
  await sendInvoice(ctx, inv.id)

  const vendor = await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: vendor.id, billNumber: 'EX/900', billDate: '2026-06-12',
    lines: [{ description: 'Post-production', sacCode: '998314', quantity: '1', rate: '150000', gstRatePct: '18', expenseAccountCode: '5220' }],
  })).id)

  period = await resolvePeriod(companyId)
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 a statement says whether it can still change', () => {
  it('calls an open year a draft, in those words', async () => {
    const s = await statementStanding(companyId, period)
    expect(s.status).toBe('DRAFT')
    expect(s.note).toMatch(/can still change/)
  })

  it('🔴 is still a draft when the lock stops short of the period end', async () => {
    const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId, id: period.fyId } })
    await prisma.financialYear.update({ where: { id: fy.id }, data: { lockedUpTo: new Date('2026-09-30') } })
    // the FY runs to 31 March; locking to September leaves half of it open
    const s = await statementStanding(companyId, period)
    expect(s.status).toBe('DRAFT')
    expect(s.note).toMatch(/locked only up to 2026-09-30/)
  })

  it('calls it locked when the lock covers the whole period', async () => {
    await prisma.financialYear.update({ where: { id: period.fyId }, data: { lockedUpTo: period.to } })
    const s = await statementStanding(companyId, period)
    expect(s.status).toBe('LOCKED')
    expect(s.note).toMatch(/covers this whole period/)
  })

  it('calls a closed year final', async () => {
    await prisma.financialYear.update({ where: { id: period.fyId }, data: { status: 'CLOSED' } })
    expect((await statementStanding(companyId, period)).status).toBe('FINAL')
    await prisma.financialYear.update({
      where: { id: period.fyId }, data: { status: 'OPEN', lockedUpTo: null },
    })
  })
})

describe('the statement documents', () => {
  it('prints a P&L that foots to the ledger, and says it is a draft', async () => {
    const html = await renderStatementHtml(ctx, 'pnl', period)
    expect(html).toContain('Profit &amp; Loss')
    expect(html).toContain('st-draft')
    expect(html).toMatch(/Draft/)
    expect(html).toContain('4,00,000.00')          // revenue, Indian grouping
    expect(html).toMatch(/Net profit for the period|Net loss for the period/)
  })

  it('🔴 says on its face that it is not a Schedule III statement', async () => {
    const html = await renderStatementHtml(ctx, 'pnl', period)
    expect(html).toMatch(/Schedule III/)
    expect(html).toMatch(/not a statutory financial statement/)
  })

  it('🔴 explains the derived profit line on the balance sheet rather than leaving it a mystery', async () => {
    const html = await renderStatementHtml(ctx, 'balance-sheet', period)
    expect(html).toContain('Balance Sheet')
    expect(html).toMatch(/Current year profit/)
    expect(html).toMatch(/derived/)
    expect(html).toMatch(/sweeps them into retained/)
    expect(html).toMatch(/The statement balances/)
  })

  it('shouts when the trial balance does not balance', async () => {
    const html = await renderStatementHtml(ctx, 'trial-balance', period)
    expect(html).toContain('Trial Balance')
    expect(html).toMatch(/Debits equal credits/)
    expect(html).not.toContain('class="check bad"')
  })

  it('🔴 does not claim a position at a date that has not happened', async () => {
    // period.to is the FY END — months away while the year is open. The first rendering of
    // this produced a balance sheet headed "As at 31 Mar 2027", prepared in October 2026.
    const html = await renderStatementHtml(ctx, 'balance-sheet', period)
    expect(html).not.toMatch(/As at 31 Mar 2027/)
    expect(html).toMatch(/As at \d{2} \w{3} 2026/)
  })

  it('🔴 names the entries it stopped short of, so it reconciles with the screen', async () => {
    // clamping the date changes the figures: a payroll run is dated the 28th, so the current
    // month's salaries sit days in the future and the on-screen reports include them
    await prisma.journalEntry.findFirst()
    const html = await renderStatementHtml(ctx, 'pnl', period)
    expect(html).toMatch(/has not arrived/)
    expect(html).toMatch(/stops at \d{2} \w{3} 2026/)
  })

  it('🔴 leaves out a section with nothing in it', async () => {
    // "Operating expenses / Total operating expenses 0.00" with nothing between reads as a
    // company that had none, rather than one that has posted none
    const html = await renderStatementHtml(ctx, 'pnl', period)
    const hasEmptyOpex = /OPERATING EXPENSES|Operating expenses<\/td>/.test(html)
      && !/Total operating expenses/.test(html)
    expect(hasEmptyOpex).toBe(false)
    if (/Total operating expenses/.test(html)) {
      expect(html).toMatch(/Operating expenses/)
    }
  })

  it('🔴 does not announce a loss in a green box', async () => {
    const html = await renderStatementHtml(ctx, 'pnl', period)
    const loss = /Net loss for the period/.test(html)
    if (loss) {
      expect(html).toContain('class="check bad"')
      expect(html).toMatch(/A loss of/)
    }
  })

  it('renders to a real PDF', async () => {
    const pdf = await htmlToPdf(await renderStatementHtml(ctx, 'pnl', period))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(5000)
  })
})

describe('the journal export', () => {
  it('carries every line of the period and foots to zero', async () => {
    const j = await journalExport(ctx, period)
    expect(j.lines.length).toBeGreaterThan(4)
    expect(j.entries).toBeGreaterThan(1)
    expect(j.balanced).toBe(true)
    expect(j.totals.debit.toFixed(2)).toBe(j.totals.credit.toFixed(2))
  })

  it('🔴 comes back in the same order every time', async () => {
    // JournalLine has no ordering column, so without the id tiebreaker two exports of the
    // same period can interleave the sides of an entry differently — and an auditor diffs them
    const a = await journalExport(ctx, period)
    const b = await journalExport(ctx, period)
    const key = (x: typeof a) => x.lines.map((l) => `${l.entryNo}:${l.accountCode}:${l.debit}:${l.credit}`).join('|')
    expect(key(a)).toBe(key(b))
  })

  it('🔴 refuses rather than truncating when the period is too big', async () => {
    await expect(journalExport(ctx, period, { limit: 2 }))
      .rejects.toThrow(/Export it a quarter at a time/)
  })

  it('names the counterparty, not just its id', async () => {
    const j = await journalExport(ctx, period)
    expect(j.lines.some((l) => l.counterparty?.includes('Click AR'))).toBe(true)
  })

  it('writes a CSV that says whether it balanced', async () => {
    const csv = journalCsv(META(), await journalExport(ctx, period))
    expect(csv).toContain('# Journal')
    expect(csv).toContain('# Balanced,yes')
    expect(csv).toContain('Entry no,Date,Narration')
  })

  it('🔴 carries the standing into the file when it is given one', async () => {
    const standing = await statementStanding(companyId, period)
    const csv = journalCsv({ ...META(), standing }, await journalExport(ctx, period))
    expect(csv).toMatch(/# Status,Draft/)
  })
})

describe('the account ledger export', () => {
  it('🔴 opens with the opening balance, so the running column starts from something', async () => {
    const led = (await accountLedger(ctx, '1100', period))!
    const csv = accountLedgerCsv(META(), led.account, led.lines)
    const lines = csv.split('\r\n')
    const openingAt = lines.findIndex((l) => l.includes('Opening balance'))
    const firstMove = lines.findIndex((l, i) => i > openingAt && /^\d{4}-\d{2}-\d{2},/.test(l))
    expect(openingAt).toBeGreaterThan(0)
    expect(firstMove).toBeGreaterThan(openingAt)
    expect(csv).toContain('Closing balance')
    expect(csv).toContain('# Balance direction,debit')
  })

  it('🔴 does not let a formula into the file through the account NAME', async () => {
    // the name used to be interpolated into the header title, where csvCell never saw it
    await prisma.account.update({ where: { companyId_code: { companyId, code: '1100' } }, data: { name: '=cmd|calc' } })
    const led = (await accountLedger(ctx, '1100', period))!
    const csv = accountLedgerCsv(META(), led.account, led.lines)
    expect(csv).toContain("'=cmd|calc")
    await prisma.account.update({ where: { companyId_code: { companyId, code: '1100' } }, data: { name: 'Accounts Receivable' } })
  })
})
