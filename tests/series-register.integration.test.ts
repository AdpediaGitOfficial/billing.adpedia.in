import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice, cancelInvoice } from '@/server/services/invoicing/invoice'
import { documentSeriesRegister, seqFromNumber, setSeriesPattern } from '@/server/services/invoicing/series-register'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', customerId = '', fyId = ''

const invoices = async () => (await documentSeriesRegister(ctx)).rows.find((r) => r.docType === 'TAX_INVOICE')!

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  fyId = (await prisma.financialYear.findFirstOrThrow({ where: { companyId, label: '2026-27' } })).id

  customerId = (await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {} },
  })).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

const raise = async (date = '2026-05-10') => sendInvoice(ctx, (await createInvoice(ctx, {
  customerId, date,
  lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
})).id)

describe('🔴 reading a sequence back out of its own number', () => {
  it('matches the pattern that produced it', () => {
    expect(seqFromNumber('ADP/{FY}/{SEQ:4}', '2026-27', 'ADP/26-27/0026')).toBe(26)
    expect(seqFromNumber('ADPC/{FY}/{SEQ:4}', '2026-27', 'ADPC/26-27/0001')).toBe(1)
  })

  it('returns nothing for a number from another series, rather than a wrong answer', () => {
    expect(seqFromNumber('ADP/{FY}/{SEQ:4}', '2026-27', 'ADPC/26-27/0001')).toBeNull()
    expect(seqFromNumber('ADP/{FY}/{SEQ:4}', '2026-27', 'DRAFT-17-abc')).toBeNull()
  })
})

describe('🔴 the series an assessment would ask about', () => {
  it('🔴 does not report the numbers issued before this system as missing', async () => {
    // Adpedia's series was seeded at 26 — twenty-five invoices were raised by hand first
    const r = await invoices()
    expect(r.openedAt).toBeGreaterThan(1)
    const pre = r.gaps.find((g) => g.reason === 'BEFORE_THIS_SYSTEM')
    expect(pre).toBeTruthy()
    expect(pre!.detail).toMatch(/issued before this system held the series/)
    expect(r.gaps.filter((g) => g.reason === 'UNEXPLAINED')).toEqual([])
  })

  it('counts an issued invoice and advances the next number', async () => {
    const before = await invoices()
    const inv = await raise()
    const after = await invoices()
    expect(after.issued).toBe(before.issued + 1)
    expect(after.lastSeq).toBe(inv.seq)
    expect(after.nextNumber).not.toBe(before.nextNumber)
    expect(after.gaps.filter((g) => g.reason === 'UNEXPLAINED')).toEqual([])
  })

  it('🔴 a cancelled invoice keeps its number and leaves no hole', async () => {
    const inv = await raise('2026-05-12')
    await cancelInvoice(ctx, inv.id, 'Raised against the wrong customer')
    const r = await invoices()
    expect(r.cancelled.some((c) => c.number === inv.number)).toBe(true)
    expect(r.cancelled.find((c) => c.number === inv.number)!.reason).toMatch(/wrong customer/)
    // the number is spoken for, so the series is still consecutive
    expect(r.gaps.filter((g) => g.reason === 'UNEXPLAINED')).toEqual([])
  })

  it('🔴 a draft has taken nothing from the series', async () => {
    const before = await invoices()
    await createInvoice(ctx, {
      customerId, date: '2026-05-14',
      lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18' }],
    })
    const after = await invoices()
    expect(after.issued).toBe(before.issued)
    expect(after.nextNumber).toBe(before.nextNumber)
    expect(after.firstSeq).toBeGreaterThan(0)
  })

  it('🔴 names a number that was taken with nothing behind it', async () => {
    // the hole this register exists to find: a sequence consumed and no document issued
    const series = await prisma.documentSeries.findFirstOrThrow({
      where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' },
    })
    await prisma.documentSeries.update({ where: { id: series.id }, data: { nextSeq: series.nextSeq + 1 } })

    const r = await invoices()
    const hole = r.gaps.find((g) => g.reason === 'UNEXPLAINED')
    expect(hole).toBeTruthy()
    expect(hole!.seq).toBe(series.nextSeq)
    expect(hole!.detail).toMatch(/no document carries it/)
    expect((await documentSeriesRegister(ctx)).unexplained).toBeGreaterThan(0)
  })
})

describe('🔴 rule 46(b), finally enforced', () => {
  it('passes the seeded pattern at its widest', async () => {
    const r = await invoices()
    expect(r.patternProblem).toBeNull()
  })

  it('reports a pattern that would breach sixteen characters', async () => {
    const series = await prisma.documentSeries.findFirstOrThrow({
      where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' },
    })
    await prisma.documentSeries.update({
      where: { id: series.id }, data: { pattern: 'ADPEDIA-FILMS/{FY}/{SEQ:6}' },
    })
    const r = await invoices()
    expect(r.patternProblem).toMatch(/Rule 46 allows 16/)
  })

  it('🔴 refuses to issue a document under it, rather than warning after the fact', async () => {
    // the validator existed with tests and no caller since docs/10; a long prefix would have
    // put a defective number on every invoice of the year with nothing saying so
    await expect(raise('2026-05-20')).rejects.toThrow(/Rule 46\(b\) limits the number to sixteen characters/)

    const series = await prisma.documentSeries.findFirstOrThrow({
      where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' },
    })
    await prisma.documentSeries.update({ where: { id: series.id }, data: { pattern: 'ADP/{FY}/{SEQ:4}' } })
  })

  it('🔴 and takes no number when it refuses', async () => {
    // a failed allocation that consumed the sequence would create the very hole this
    // register reports — the throw happens before the increment, inside the transaction
    const before = (await invoices()).nextNumber
    await prisma.documentSeries.updateMany({
      where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' },
      data: { pattern: 'ADPEDIA-FILMS/{FY}/{SEQ:6}' },
    })
    await expect(raise('2026-05-22')).rejects.toThrow()
    await prisma.documentSeries.updateMany({
      where: { companyId, financialYearId: fyId, docType: 'TAX_INVOICE' },
      data: { pattern: 'ADP/{FY}/{SEQ:4}' },
    })
    expect((await invoices()).nextNumber).toBe(before)
  })
})

/**
 * 🔴 docs/83 §6 — choosing the shape of your own numbers.
 *
 * The pattern was readable on this page and settable nowhere. A business that numbers its
 * invoices `30/ADP/26-27` could not say so: the format of every document it issues was fixed
 * by the seed script and changeable only in the database.
 */
describe('🔴 the series pattern is the company\u2019s to choose', () => {
  const pattern = async () => (await invoices()).pattern

  it('changes the shape of the next number', async () => {
    const before = await invoices()
    const r = await setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: '{SEQ}/ADP/{FY}' })

    expect(r.nextNumber).toBe(`${before.nextSeq}/ADP/26-27`)
    expect((await invoices()).nextNumber).toBe(r.nextNumber)

    const inv = await raise('2026-06-02')
    expect(inv.number).toBe(`${before.nextSeq}/ADP/26-27`)
  })

  /**
   * 🔴 The run is the SEQUENCE, not the string it is printed into. Rule 46(b) wants it
   * consecutive; changing the format is not a gap, and moving `nextSeq` would make one.
   */
  it('and does not move the sequence, so nothing goes missing from the run', async () => {
    const before = await invoices()
    await setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: 'ADP-{SEQ:4}/{FY}' })
    const after = await invoices()

    expect(after.nextSeq).toBe(before.nextSeq)
    expect(after.firstSeq).toBe(before.firstSeq)
    // 🔴 no NEW hole. Earlier tests in this file deliberately leave one, so the question is
    // whether changing the format opened another — and the gaps are compared by sequence,
    // because the `number` on each one is rendered from the pattern that just changed.
    expect(after.gaps.map((g) => g.seq)).toEqual(before.gaps.map((g) => g.seq))
    expect(after.gaps.map((g) => g.reason)).toEqual(before.gaps.map((g) => g.reason))
  })

  it('keeps every number already issued exactly as it went out', async () => {
    const issued = await prisma.invoice.findMany({
      where: { companyId, financialYearId: fyId, seq: { gt: 0 } }, select: { number: true, seq: true },
      orderBy: { seq: 'asc' },
    })
    await setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: '{SEQ:4}-ADP/{FY}' })
    const again = await prisma.invoice.findMany({
      where: { companyId, financialYearId: fyId, seq: { gt: 0 } }, select: { number: true, seq: true },
      orderBy: { seq: 'asc' },
    })
    expect(again).toEqual(issued)
  })

  /**
   * 🔴 Checked at 9999, not at the next number — the same widest-case rule the register
   * applies. A pattern that fits today and breaches sixteen characters in October would
   * otherwise be accepted now and block issuing then.
   */
  it('refuses a pattern that breaches rule 46 later in the year', async () => {
    const before = await pattern()
    await expect(setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: 'ADPEDIAFILMS/{SEQ:4}/{FY}' }))
      .rejects.toThrow(/sixteen characters/)
    expect(await pattern()).toBe(before)
  })

  it('refuses one with no sequence or no year, and changes nothing', async () => {
    const before = await pattern()
    await expect(setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: 'ADP/{FY}' })).rejects.toThrow(/\{SEQ\}/)
    await expect(setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: 'ADP/{SEQ:4}' })).rejects.toThrow(/\{FY\}/)
    expect(await pattern()).toBe(before)
  })

  it('🔴 writes the change to the audit log — it changes what every future document is called', async () => {
    await setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: '{SEQ}/ADP/{FY}' })
    const entry = await prisma.auditLog.findFirst({
      where: { companyId, entity: 'DocumentSeries', action: 'UPDATE' }, orderBy: { at: 'desc' },
    })
    expect(entry).toBeTruthy()
    expect(JSON.stringify(entry!.after)).toContain('{SEQ}/ADP/{FY}')
  })

  /**
   * 🔴 The archived copy is filed under the WHOLE number.
   *
   * `safeLabel` strips anything before the last `/` — it is a path-traversal guard, and it
   * cannot tell a directory from an invoice number. `ADP/26-27/0030` was stored as
   * `0030.pdf`; under `{SEQ}/ADP/{FY}` the same invoice stored as `26-27.pdf`, which is what
   * every invoice in the year would be called. The number has to survive the guard, so it
   * goes through `pdfFilename` before the guard ever sees it.
   */
  it('files the archived copy under the whole number, whatever the pattern', async () => {
    await setSeriesPattern(ctx, { docType: 'TAX_INVOICE', pattern: '{SEQ}/ADP/{FY}' })
    const inv = await raise('2026-06-10')

    const copy = await prisma.attachment.findFirst({
      where: { companyId, entityType: 'Invoice', entityId: inv.id },
    })
    expect(copy, 'the invoice was not archived at all').toBeTruthy()
    expect(copy!.filename).toBe(`${inv.number.replace(/\//g, '-')}.pdf`)
    expect(copy!.filename).not.toBe('26-27.pdf')
  }, 60_000)
})
