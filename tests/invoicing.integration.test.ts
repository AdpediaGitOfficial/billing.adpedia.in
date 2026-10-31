import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { allocateNumber } from '@/server/services/invoicing/numbering'
import { resolveLutForInvoice, LutMissing } from '@/server/services/invoicing/lut'

const prisma = new PrismaClient()
let companyId = '', fyId = '', fyLabel = ''

beforeAll(async () => {
  await resetDb(prisma)
  const c = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  companyId = c.id
  const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })
  fyId = fy.id; fyLabel = fy.label
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 invoice numbering under concurrency', () => {
  it('50 parallel allocations yield 50 distinct, gapless, sequential numbers', async () => {
    const before = await prisma.documentSeries.findFirstOrThrow({ where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' } })

    // every allocation in its own transaction, all fired at once
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        prisma.$transaction((tx) => allocateNumber(tx, { companyId, financialYearId: fyId, docType: 'TAX_INVOICE', fyLabel })),
      ),
    )

    const numbers = results.map((r) => r.number)
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)

    expect(new Set(numbers).size).toBe(50)                       // no duplicates
    expect(seqs[0]).toBe(before.nextSeq)                         // starts where the series was
    expect(seqs[49]).toBe(before.nextSeq + 49)                   // ends 49 later
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1)   // no gaps

    const after = await prisma.documentSeries.findFirstOrThrow({ where: { id: before.id } })
    expect(after.nextSeq).toBe(before.nextSeq + 50)
  })

  it('renders the confirmed Adpedia format', async () => {
    const { number } = await prisma.$transaction((tx) =>
      allocateNumber(tx, { companyId, financialYearId: fyId, docType: 'TAX_INVOICE', fyLabel }),
    )
    expect(number).toMatch(/^ADP\/26-27\/\d{4}$/)
    expect(number.length).toBeLessThanOrEqual(16)
  })

  it('export invoices draw from their own series', async () => {
    const { number } = await prisma.$transaction((tx) =>
      allocateNumber(tx, { companyId, financialYearId: fyId, docType: 'EXPORT_INVOICE', fyLabel }),
    )
    expect(number).toMatch(/^ADPX\/26-27\/\d{4}$/)
    expect(number.length).toBeLessThanOrEqual(16)
  })
})

describe('🔴 the LUT guard', () => {
  it('blocks a zero-rated export when no LUT covers the financial year', async () => {
    await expect(
      resolveLutForInvoice(prisma, { companyId, taxMode: 'EXPORT', fyLabel: '2026-27', docType: 'EXPORT_INVOICE' }),
    ).rejects.toThrow(LutMissing)
  })

  it('names the remedy, not just the problem', async () => {
    await expect(
      resolveLutForInvoice(prisma, { companyId, taxMode: 'EXPORT', fyLabel: '2026-27', docType: 'EXPORT_INVOICE' }),
    ).rejects.toThrow(/Form RFD-11[\s\S]*or raise this invoice with IGST/)
  })

  it('allows it once a LUT for that year exists', async () => {
    await prisma.companyLut.create({
      data: {
        companyId, arn: 'AD320326TEST001', fyLabel: '2026-27',
        validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31'),
      },
    })
    const id = await resolveLutForInvoice(prisma, { companyId, taxMode: 'EXPORT', fyLabel: '2026-27', docType: 'EXPORT_INVOICE' })
    expect(id).toBeTruthy()
    await prisma.companyLut.deleteMany({ where: { arn: 'AD320326TEST001' } })
  })

  /**
   * 🔴 docs/82 §4 — the case that could not be sent at all.
   *
   * An unregistered supplier billing abroad resolves to taxMode EXPORT, and this guard then
   * demanded Form RFD-11 — which only a registered person can file. The remedy it named was
   * one the supplier cannot perform, so the invoice simply could not be issued.
   */
  it('🔴 does not require a LUT for a bill of supply, which has no rate to zero', async () => {
    expect(await resolveLutForInvoice(prisma, {
      companyId, taxMode: 'EXPORT', fyLabel: '2026-27', docType: 'BILL_OF_SUPPLY',
    })).toBeNull()
  })

  it('does not require a LUT for domestic invoices', async () => {
    expect(await resolveLutForInvoice(prisma, { companyId, taxMode: 'INTRA', fyLabel: '2026-27', docType: 'TAX_INVOICE' })).toBeNull()
    expect(await resolveLutForInvoice(prisma, { companyId, taxMode: 'INTER', fyLabel: '2026-27', docType: 'TAX_INVOICE' })).toBeNull()
  })
})
