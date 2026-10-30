import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { createCreditNote } from '@/server/services/invoicing/credit-note'
import { createDebitNote } from '@/server/services/invoicing/debit-note'
import { recordAmendment } from '@/server/services/tax/gst-amendment'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import { trialBalance } from '@/server/services/reports/statements'
import type { RequestContext } from '@/server/context'

/**
 * 🔴 The project dimension must survive every adjustment, not just the invoice.
 *
 * `postInvoice` stamps `projectId` on all of its lines, tax included. Every LATER document
 * that moves the same tax — a credit note, a debit note, an amendment — spelled the dimension
 * out per posting instead, and in each one the tax lines were the ones that missed it. The
 * arithmetic was right and the trial balance balanced; only the per-project view was wrong,
 * and it was wrong in one direction: a project's output GST could rise and never fall.
 *
 * That is invisible until somebody asks what a project actually earned and what of it was
 * only ever the government's.
 */

const prisma = new PrismaClient()
let ctx: RequestContext
let customerId = ''
let projectId = ''
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  customerId = (await prisma.customer.create({ data: {
    companyId: company.id, name: 'Iriscapes LLP', country: 'IN', stateCode: '32',
    gstin: '32AABFI1234K1Z5', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
  } })).id

  projectId = (await prisma.project.create({ data: {
    companyId: company.id, customerId, code: 'DV', name: 'Divine Ragas', contractValue: '800000',
  } })).id
})
afterAll(async () => { await prisma.$disconnect() })

/** Output tax on one head, as the project reports it — the figure the whole fix is about. */
async function projectOutputTax(code: string) {
  const lines = await prisma.journalLine.findMany({
    where: { projectId, account: { code }, journalEntry: { companyId: ctx.companyId } },
    select: { debit: true, credit: true },
  })
  return lines.reduce((sum, l) => sum + Number(l.credit) - Number(l.debit), 0)
}

/** Any line of this company's output tax that belongs to no project at all. */
async function untaggedOutputTax() {
  return prisma.journalLine.findMany({
    where: {
      projectId: null,
      account: { code: { in: ['2110', '2120', '2130'] } },
      journalEntry: { companyId: ctx.companyId },
    },
    include: { account: { select: { code: true } }, journalEntry: { select: { narration: true } } },
  })
}

describe('the project dimension on output tax', () => {
  it('an invoice tags its tax lines, not only its revenue', async () => {
    const draft = await createInvoice(ctx, {
      customerId, projectId, date: '2026-05-01',
      lines: [{ description: 'Devine Ragas mobile app', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
    })
    await sendInvoice(ctx, draft.id)

    expect(await projectOutputTax('2110')).toBeCloseTo(9000, 2)
    expect(await projectOutputTax('2120')).toBeCloseTo(9000, 2)
  })

  it('🔴 a credit note takes it back off the SAME project', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { projectId } })
    await createCreditNote(ctx, {
      invoiceId: inv.id, date: '2026-06-01', taxableValue: '20000',
      reason: 'Scope reduced by agreement',
    })

    // 9000 charged less 1800 credited. Before the fix this still read 9000 — the reversal
    // landed on the company and the project never heard about it.
    expect(await projectOutputTax('2110')).toBeCloseTo(7200, 2)
    expect(await projectOutputTax('2120')).toBeCloseTo(7200, 2)
  })

  it('a debit note adds to it', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { projectId } })
    await createDebitNote(ctx, {
      invoiceId: inv.id, date: '2026-06-10', taxableValue: '10000',
      reason: 'Additional screens agreed after sign-off',
    })

    expect(await projectOutputTax('2110')).toBeCloseTo(8100, 2)
    expect(await projectOutputTax('2120')).toBeCloseTo(8100, 2)
  })

  it('and so does an amendment, posted in the period that reports it', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { projectId } })
    await recordGstFiling(ctx, { returnType: 'GSTR1', periodLabel: '2026-Q1', filedOn: '2026-07-13' })

    await recordAmendment(ctx, {
      invoiceId: inv.id, date: '2026-09-15', taxableValue: '110000',
      reason: 'Billed one milestone short of the agreed schedule',
    })

    // the amendment moves the invoice 100000 → 110000, so 900 more on each half
    expect(await projectOutputTax('2110')).toBeCloseTo(9000, 2)
    expect(await projectOutputTax('2120')).toBeCloseTo(9000, 2)
  })

  it('🔴 leaves no output-tax line stranded off the project', async () => {
    const stranded = await untaggedOutputTax()
    expect(
      stranded.map((l) => `${l.account.code} ${l.journalEntry.narration}`),
      'every document here is on one project, so nothing should sit outside it',
    ).toEqual([])
  })

  it('still balances', async () => {
    expect((await trialBalance(ctx, PERIOD)).balanced).toBe(true)
  })
})

/**
 * 🔴 The behavioural tests above cover the four documents that exist today. This covers the
 * fifth, whoever writes it — docs/49 §1's lesson is that the survey has to be a script.
 */
describe('no new posting may drop the dimension', () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) files(p, out)
      else if (p.endsWith('.ts')) out.push(p)
    }
    return out
  }

  /**
   * The advance pair is deliberately outside this. An advance is received before any invoice
   * exists, so its tax is booked with no project to book it against; the absorption then
   * reverses that same untagged tax. Tagging only the second half would subtract tax from a
   * project that was never credited with it, and understate the project — the exact mirror of
   * the bug this file is about.
   */
  const EXEMPT = ['services/sales/advance.ts']

  it('every output-tax posting carries a project', () => {
    const offenders: string[] = []
    for (const file of files('src/server/services')) {
      if (EXEMPT.some((e) => file.replace(/\\/g, '/').includes(e))) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/accountCode: *'(2110|2120|2130)'/.test(line)) return
        /**
         * 🔴 Scope the check to THIS posting, not to a window of lines.
         *
         * A blind four-line window was the first version of this test, and it passed while
         * the bug was live: the CGST posting had lost its dimension and the window simply
         * read the SGST posting on the next line, which still had one. A guard that borrows
         * its evidence from the line below is not a guard.
         *
         * A posting written on one line must carry it on that line. Only where the object is
         * spread over several — `accountCode` alone on its own line — is it read further.
         */
        const fieldOnly = /^accountCode: *'(2110|2120|2130)',?$/.test(line.trim())
        const scope = fieldOnly ? lines.slice(i, i + 6).join('\n') : line
        if (!/projectId|\.\.\.dim/.test(scope)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`)
        }
      })
    }
    expect(offenders, 'output tax moves a project\'s figures; post it with the project').toEqual([])
  })
})
