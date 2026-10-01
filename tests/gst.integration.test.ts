import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { gstPosition, outwardSupplies } from '@/server/services/tax/gst-ledger'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { buildGstr3b } from '@/server/services/tax/gstr3b'
import { gstr1ToCsv, gstr3bToCsv } from '@/server/services/tax/gst-export'
import { addLut } from '@/server/services/invoicing/lut'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let kerala = '', mumbai = '', dubai = '', b2c = ''
// 🔴 Integration tests share one database, so each file works in its own date window.
// The lifecycle and render suites use September; this one uses Q1 (Apr–Jun) so the
// ledger figures below belong to these invoices alone.
const INVOICE_DATE = '2026-05-15'
const FROM = new Date('2026-04-01'), TO = new Date('2026-06-30T23:59:59Z')

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  const mk = (name: string, country: string, stateCode: string | null, gstin: string | null, type: 'B2B' | 'B2C' | 'EXPORT') =>
    prisma.customer.create({ data: { companyId: company.id, name, country, stateCode, gstin, customerType: type, billingAddress: {}, paymentTermDays: 15 } })

  kerala = (await mk('Click AR Business Pvt Ltd', 'IN', '32', '32AAKCC9890P1ZS', 'B2B')).id
  mumbai = (await mk('Nuvé Properties Pvt Ltd', 'IN', '27', '27AABCN1234M1Z5', 'B2B')).id
  dubai  = (await mk('Nuvé Holdings FZ-LLC', 'AE', null, null, 'EXPORT')).id
  b2c    = (await mk('Walk-in Client', 'IN', '32', null, 'B2C')).id

  const lines = [
    { description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '70000', gstRatePct: '18' },
    { description: 'UI/UX revisions', sacCode: '998391', quantity: '2', rate: '7500', gstRatePct: '18' },
  ]
  for (const customerId of [kerala, mumbai, b2c]) {
    const d = await createInvoice(ctx, { customerId, date: INVOICE_DATE, tdsSection: '194J', lines })
    await sendInvoice(ctx, d.id)
  }
  await addLut(ctx, { arn: 'AD320326123456Z', fyLabel: '2026-27', filedOn: '2026-03-20' })
  const exp = await createInvoice(ctx, { customerId: dubai, date: INVOICE_DATE, lines })
  await sendInvoice(ctx, exp.id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('GST position is read from the ledger', () => {
  it('output tax matches what the invoices posted', async () => {
    const p = await gstPosition(ctx.companyId, FROM, TO)
    // Kerala + B2C are intra-state (CGST+SGST 7,650 each), Mumbai is IGST 15,300, export is nil
    expect(p.output.cgst.toFixed(2)).toBe('15300.00')
    expect(p.output.sgst.toFixed(2)).toBe('15300.00')
    expect(p.output.igst.toFixed(2)).toBe('15300.00')
    expect(p.output.total.toFixed(2)).toBe('45900.00')
  })

  it('no input credit yet — vendor bills arrive in phase 3', async () => {
    const p = await gstPosition(ctx.companyId, FROM, TO)
    expect(p.input.total.toFixed(2)).toBe('0.00')
    expect(p.net.toFixed(2)).toBe('45900.00')
  })

  it('splits taxable from zero-rated turnover', async () => {
    const s = await outwardSupplies(ctx.companyId, FROM, TO)
    expect(s.taxable.taxable.toFixed(2)).toBe('255000.00')   // 3 × 85,000
    expect(s.zeroRated.taxable.toFixed(2)).toBe('85000.00')  // the export
    expect(s.zeroRated.igst.toFixed(2)).toBe('0.00')
  })
})

describe('GSTR-1', () => {
  it('puts registered recipients in b2b and unregistered in b2cs', async () => {
    const r = await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1')
    expect(r.b2b).toHaveLength(2)                      // Kerala + Mumbai, one row each at 18%
    expect(r.b2b.every((b) => b.gstin && b.rate === 18)).toBe(true)
    expect(r.b2b.find((b) => b.gstin.startsWith('27'))?.igst.toFixed(2)).toBe('15300.00')
    expect(r.b2b.find((b) => b.gstin.startsWith('32'))?.cgst.toFixed(2)).toBe('7650.00')

    expect(r.b2cs).toHaveLength(1)                     // the unregistered customer, consolidated
    expect(r.b2cs[0].taxableValue.toFixed(2)).toBe('85000.00')
    expect(r.b2cs[0].placeOfSupply).toBe('32')
  })

  it('reports the export as WOPAY because a LUT is linked', async () => {
    const r = await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1')
    expect(r.exports).toHaveLength(1)
    expect(r.exports[0].exportType).toBe('WOPAY')
    expect(r.exports[0].lutArn).toBe('AD320326123456Z')
    expect(r.exports[0].igst.toFixed(2)).toBe('0.00')
  })

  it('summarises HSN/SAC across every invoice', async () => {
    const r = await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1')
    const sacs = r.hsn.map((h) => h.sac).sort()
    expect(sacs).toEqual(['998314', '998391'])
    expect(r.hsn.find((h) => h.sac === '998314')!.taxableValue.toFixed(2)).toBe('280000.00')  // 4 × 70,000
    expect(r.hsn.find((h) => h.sac === '998391')!.taxableValue.toFixed(2)).toBe('60000.00')   // 4 × 15,000
  })

  it('reports the document series actually issued', async () => {
    const r = await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1')
    const tax = r.docs.find((d) => d.type.includes('tax invoice'))
    expect(tax?.total).toBe(3)
    expect(r.docs.find((d) => d.type.includes('export'))?.total).toBe(1)
  })

  it('totals reconcile to the sum of the invoices', async () => {
    const r = await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1')
    expect(r.totals.taxableValue.toFixed(2)).toBe('340000.00')   // 4 × 85,000
    expect(r.totals.cgst.plus(r.totals.sgst).plus(r.totals.igst).toFixed(2)).toBe('45900.00')
  })
})

describe('GSTR-3B', () => {
  it('maps to the right tables', async () => {
    const r = await buildGstr3b(ctx.companyId, FROM, TO, '2026-Q1')
    expect(r.t31a.taxable.toFixed(2)).toBe('255000.00')
    expect(r.t31b.taxable.toFixed(2)).toBe('85000.00')   // zero-rated
    expect(r.t4c.toFixed(2)).toBe('0.00')                // no ITC yet
    expect(r.payable.inCash.toFixed(2)).toBe('45900.00') // all of it in cash
    expect(r.payable.throughItc.toFixed(2)).toBe('0.00')
  })

  it('says why there is no ITC rather than leaving a bare zero', async () => {
    const r = await buildGstr3b(ctx.companyId, FROM, TO, '2026-Q1')
    expect(r.notes.join(' ')).toMatch(/phase 3/)
  })
})

describe('CSV export for the CA', () => {
  it('produces every GSTR-1 section with quoted cells', async () => {
    const csv = gstr1ToCsv(await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1'))
    for (const section of ['# b2b', '# b2cs', '# exp', '# cdnr', '# hsn', '# docs']) {
      expect(csv, `missing ${section}`).toContain(section)
    }
    expect(csv).toContain('32AAKCC9890P1ZS')
    expect(csv).toContain('998314')
    expect(csv).toContain('not a portal filing')
  })

  it('quotes a value containing a comma so columns do not shift', async () => {
    await prisma.customer.update({ where: { id: kerala }, data: { name: 'Click AR Business, Private Limited' } })
    const csv = gstr1ToCsv(await buildGstr1(ctx.companyId, FROM, TO, '2026-Q1'))
    expect(csv).toContain('"Click AR Business, Private Limited"')
    await prisma.customer.update({ where: { id: kerala }, data: { name: 'Click AR Business Pvt Ltd' } })
  })

  it('produces the GSTR-3B table mapping', async () => {
    const csv = gstr3bToCsv(await buildGstr3b(ctx.companyId, FROM, TO, '2026-Q1'))
    expect(csv).toContain('3.1(a)')
    expect(csv).toContain('3.1(b)')
    expect(csv).toContain('6.1')
    expect(csv).toContain('45900.00')
  })
})

describe('LUT register validation', () => {
  it('refuses an ARN from the wrong financial year', async () => {
    await expect(addLut(ctx, { arn: 'AD320324005917B', fyLabel: '2026-27' }))
      .rejects.toThrow(/covers FY 2024-25 — not FY 2026-27/)
  })

  it('refuses an ARN issued in another state', async () => {
    await expect(addLut(ctx, { arn: 'AD270326123456Z', fyLabel: '2026-27' }))
      .rejects.toThrow(/issued in state 27.*registered in 32/)
  })

  it('accepts a correct one and makes it the current-year LUT', async () => {
    const lut = await prisma.companyLut.findFirstOrThrow({ where: { companyId: ctx.companyId, fyLabel: '2026-27' } })
    expect(lut.arn).toBe('AD320326123456Z')
    expect(lut.validFrom.toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(lut.validTo.toISOString().slice(0, 10)).toBe('2027-03-31')
  })
})
