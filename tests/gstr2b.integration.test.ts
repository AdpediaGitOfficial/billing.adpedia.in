import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { import2b, reconcile2b } from '@/server/services/tax/gstr2b'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = ''
let exalture = '', blink = '', noGstin = ''

const b2b = (suppliers: unknown[]) => JSON.stringify({ data: { docdata: { b2b: suppliers } } })

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  exalture = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })).id
  blink = (await createVendor(ctx, {
    name: 'Blink Digital', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '29',
    gstin: '29AABCB1234F1Z5', pan: 'AABCB1234F', defaultTdsSection: '194C',
  })).id
  noGstin = (await createVendor(ctx, {
    name: 'Chalakudy Prints', vendorType: 'SUPPLIER', country: 'IN', stateCode: '32',
    pan: 'AABCC1111C', defaultTdsSection: '194C',
  })).id

  // EX-300 intra-state: the supplier files it as EX/300
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: exalture, billNumber: 'EX-300', billDate: '2026-06-10',
    lines: [{ description: 'Post-production', sacCode: '998314', quantity: '1', rate: '200000', gstRatePct: '18', expenseAccountCode: '5220' }],
  })).id)

  // BD/55 inter-state, which the supplier never reports
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: blink, billNumber: 'BD/55', billDate: '2026-08-12',
    lines: [{ description: 'Edit suite', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18', expenseAccountCode: '5220' }],
  })).id)

  /**
   * 🔴 The dangerous case, built deliberately: a bill that CLAIMS credit against a vendor
   * with no GSTIN.
   *
   * A vendor who never had one produces no GST and no credit at all — `createBill` sees to
   * that, so those bills are rightly outside this reconciliation. The one that matters is a
   * taxed bill whose vendor's GSTIN was cleared afterwards: the claim is live and there is
   * nothing to match it against.
   */
  await prisma.vendor.update({ where: { id: noGstin }, data: { gstin: '32AABCC1111C1Z9' } })
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: noGstin, billNumber: 'CP/9', billDate: '2026-08-20',
    lines: [{ description: 'Printing', sacCode: '998912', quantity: '1', rate: '10000', gstRatePct: '18', expenseAccountCode: '5310' }],
  })).id)
  await prisma.vendor.update({ where: { id: noGstin }, data: { gstin: null } })
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 matching invoice by invoice', () => {
  beforeAll(async () => {
    await import2b(ctx, {
      asOn: '2026-09-14', filename: '2b-aug-2026.json',
      text: b2b([
        {
          ctin: '32AABCE1234F1Z5', trdnm: 'Exalture Software Lab',
          inv: [{ inum: 'EX/300', idt: '10-06-2026', itcavl: 'Y', items: [{ txval: 200000, cgst: 18000, sgst: 18000 }] }],
        },
        {
          ctin: '27AAACM1111M1ZP', trdnm: 'Mumbai Sound Studio',
          inv: [{ inum: 'MSS/88', idt: '15-08-2026', itcavl: 'Y', items: [{ txval: 40000, igst: 7200 }] }],
        },
      ]),
    })
  })

  it('🔴 matches EX-300 to EX/300, which no literal comparison would', async () => {
    const r = await reconcile2b(ctx)
    const m = r.matched.find((x) => x.billNumber === 'EX-300')
    expect(m).toBeTruthy()
    expect(m!.tier).toBe('GSTIN and invoice number')
    expect(m!.ourTax.toFixed(2)).toBe('36000.00')
    expect(m!.difference.toFixed(2)).toBe('0.00')
  })

  it('🔴 names the supplier who has not filed, and what it costs', async () => {
    const r = await reconcile2b(ctx)
    const missing = r.notInPortal.find((x) => x.billNumber === 'BD/55')
    expect(missing).toBeTruthy()
    expect(missing!.vendorName).toBe('Blink Digital')
    expect(missing!.action).toMatch(/s\.16\(2\)\(aa\)/)
    expect(missing!.action).toMatch(/reversed with interest at 18%/)
    expect(missing!.tax.toFixed(2)).toBe('9000.00')
  })

  it('🔴 says something different where there is no GSTIN to match against', async () => {
    const r = await reconcile2b(ctx)
    const row = r.notInPortal.find((x) => x.billNumber === 'CP/9')!
    expect(row.action).toMatch(/no GSTIN on record/)
    expect(row.action).not.toMatch(/Ask them to include it/)
  })

  it('🔴 reports an invoice the portal has and the books do not', async () => {
    const r = await reconcile2b(ctx)
    const extra = r.notInBooks.find((x) => x.docNumber === 'MSS/88')
    expect(extra).toBeTruthy()
    expect(extra!.action).toMatch(/nobody has claimed/)
    expect(extra!.action).toMatch(/expense missing from the P&L/)
    expect(r.totals.creditUnclaimed.toFixed(2)).toBe('7200.00')
  })

  it('counts only the credit actually at risk', async () => {
    const r = await reconcile2b(ctx)
    // BD/55 ₹9,000 + CP/9 ₹1,800 — not the matched invoice, and not the unclaimed one
    expect(r.totals.creditAtRisk.toFixed(2)).toBe('10800.00')
    expect(r.verdict).toMatch(/of credit at risk/)
  })

  it('writes the match back against the 2B row', async () => {
    await reconcile2b(ctx)
    const line = await prisma.gst2bLine.findFirstOrThrow({ where: { companyId, docKey: 'EX300' } })
    expect(line.matchedBillId).not.toBeNull()
  })
})

describe('🔴 what the portal itself refuses', () => {
  it('reports a matched invoice the portal says may not be claimed', async () => {
    await import2b(ctx, {
      asOn: '2026-09-15',
      text: b2b([{
        ctin: '32AABCE1234F1Z5', trdnm: 'Exalture Software Lab',
        inv: [{
          inum: 'EX/300', idt: '10-06-2026', itcavl: 'N',
          rsn: 'Return filed after the section 16(4) deadline',
          items: [{ txval: 200000, cgst: 18000, sgst: 18000 }],
        }],
      }]),
    })
    const r = await reconcile2b(ctx)
    expect(r.matched.find((m) => m.billNumber === 'EX-300')).toBeUndefined()
    const blocked = r.blocked.find((m) => m.billNumber === 'EX-300')
    expect(blocked).toBeTruthy()
    expect(blocked!.blockedByPortal).toMatch(/section 16\(4\)/)
    // and it counts against us, because our books claimed it
    expect(r.totals.creditAtRisk.gte('36000')).toBe(true)
  })
})

describe('🔴 a supplier who has not filed becomes a chase', () => {
  it('turns the gap into a message naming the invoice and the money', async () => {
    const { outstandingChases } = await import('@/server/services/compliance/chases')
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'GSTR1_NOT_FILED' && c.partyName === 'Blink Digital')
    expect(row).toBeTruthy()
    expect(row!.body).toMatch(/BD\/55/)
    expect(row!.body).toMatch(/Section 16\(2\)\(aa\)/)
    expect(row!.body).toMatch(/declared in your GSTR-1/)
    expect(row!.amount!.toFixed(2)).toBe('9000.00')
  })

  it('🔴 says nothing to a supplier with no GSTIN, because there is nothing to ask them to file', async () => {
    const { outstandingChases } = await import('@/server/services/compliance/chases')
    const chases = await outstandingChases(ctx)
    expect(chases.some((c) => c.kind === 'GSTR1_NOT_FILED' && c.partyName === 'Chalakudy Prints')).toBe(false)
  })

  it('🔴 comparing does not write, so a screen that reads it has no side effect', async () => {
    const { compare2b } = await import('@/server/services/tax/gstr2b')
    await prisma.gst2bLine.updateMany({ where: { companyId }, data: { matchedBillId: null } })
    await compare2b(ctx)
    const touched = await prisma.gst2bLine.count({ where: { companyId, matchedBillId: { not: null } } })
    expect(touched).toBe(0)
    // and reconciling does
    await reconcile2b(ctx)
    expect(await prisma.gst2bLine.count({ where: { companyId, matchedBillId: { not: null } } })).toBeGreaterThan(0)
  })
})

describe('before anything is imported', () => {
  it('says so rather than reporting every bill as missing', async () => {
    const other = await prisma.company.create({
      data: { legalName: 'Second Co', pan: 'AAACS1111S', stateCode: '32', registeredAddress: {} },
    })
    const r = await reconcile2b({ ...ctx, companyId: other.id })
    expect(r.verdict).toBe('No GSTR-2B imported')
    expect(r.notInPortal).toEqual([])
    expect(r.totals.creditAtRisk.toFixed(2)).toBe('0.00')
  })
})
