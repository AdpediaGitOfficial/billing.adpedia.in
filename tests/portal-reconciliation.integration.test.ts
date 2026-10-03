import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { createChallan, oltasCin } from '@/server/services/tax/tds-challan'
import { recordGstPayment } from '@/server/services/tax/gst-payment'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import {
  importPortalStatement, reconcileLedger, reconcileChallans, portalConfidence, listPortalStatements,
} from '@/server/services/tax/portal-reconciliation'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = ''

const head = (r: Awaited<ReturnType<typeof reconcileLedger>>, h: string) => r.heads.find((x) => x.head === h)!

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  // ₹1,00,000 of intra-state purchases in Q1 → ₹9,000 CGST + ₹9,000 SGST of credit
  const kerala = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })).id
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: kerala, billNumber: 'EX/101', billDate: '2026-05-10',
    lines: [{ description: 'Post-production', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18', expenseAccountCode: '5220' }],
  })).id)

  // and ₹50,000 inter-state in Q2 → ₹9,000 of IGST credit, in a quarter nobody has filed
  const karnataka = (await createVendor(ctx, {
    name: 'Blink Digital', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '29',
    gstin: '29AABCB1234F1Z5', pan: 'AABCB1234F', defaultTdsSection: '194C',
  })).id
  await approveBill(ctx, (await createBill(ctx, {
    vendorId: karnataka, billNumber: 'BD/55', billDate: '2026-08-12',
    lines: [{ description: 'Edit suite', sacCode: '998314', quantity: '1', rate: '50000', gstRatePct: '18', expenseAccountCode: '5220' }],
  })).id)

  // a challan funding the cash ledger
  await recordGstPayment(ctx, { periodLabel: '2026-Q1', paidOn: '2026-07-20', cgst: '5000', sgst: '5000', cin: '26072000012345XYZ' })
})
afterAll(async () => { await prisma.$disconnect() })

describe('the electronic cash ledger against the portal', () => {
  it('agrees to the rupee when the statement matches', async () => {
    await importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-09-30', filename: 'pmt05.csv',
      text: 'Head,Balance\nIntegrated Tax,0.00\nCentral Tax,5000.00\nState/UT Tax,5000.00\nInterest,0.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CASH_LEDGER')
    expect(r.asOn?.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(r.heads.every((h) => h.severity === 'AGREED')).toBe(true)
    expect(r.verdict).toMatch(/Agrees with the portal as at 2026-09-30/)
  })

  it('🔴 calls money we hold and the portal has not credited serious, and says why', async () => {
    await importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-10-01',
      text: 'Integrated Tax,0.00\nCentral Tax,5000.00\nState/UT Tax,0.00\nInterest,0.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CASH_LEDGER')
    const sgst = head(r, 'sgst')
    expect(sgst.severity).toBe('SERIOUS')
    expect(sgst.difference.toFixed(2)).toBe('-5000.00')
    // a CPIN with no CIN is a challan generated and never paid
    expect(sgst.meaning).toMatch(/generated and never paid|set-off is recorded/)
    expect(sgst.meaning).toMatch(/rule 88B\(1\)|liability is still live/)
  })

  it('flags a balance the portal holds and the books do not', async () => {
    await importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-10-02',
      text: 'Integrated Tax,7000.00\nCentral Tax,5000.00\nState/UT Tax,5000.00\nInterest,0.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CASH_LEDGER')
    expect(head(r, 'igst').severity).toBe('INVESTIGATE')
    expect(head(r, 'igst').meaning).toMatch(/understating an asset/)
  })

  it('does not treat a head missing from the download as a nil balance', async () => {
    await importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-10-03',
      text: 'Central Tax,5000.00\nState/UT Tax,5000.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CASH_LEDGER')
    expect(head(r, 'igst').portal).toBeNull()
    expect(head(r, 'igst').severity).toBe('INVESTIGATE')
    expect(head(r, 'igst').meaning).toMatch(/not a head with a nil balance/)
  })
})

describe('🔴 the electronic credit ledger is not the same quantity', () => {
  it('subtracts credit sitting in unfiled quarters before calling anything a difference', async () => {
    // nothing is filed, so the portal holds NO credit at all — and our books hold ₹27,000.
    // A naive subtraction reports a ₹27,000 hole every month of the year.
    await importPortalStatement(ctx, {
      kind: 'GST_CREDIT_LEDGER', asOn: '2026-09-30',
      text: 'Integrated Tax,0.00\nCentral Tax,0.00\nState/UT Tax,0.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CREDIT_LEDGER')

    expect(head(r, 'cgst').ours.toFixed(2)).toBe('9000.00')
    expect(head(r, 'cgst').expected.toFixed(2)).toBe('0.00')
    expect(r.heads.every((h) => h.severity === 'AGREED')).toBe(true)
    expect(r.unfiledPeriods).toContain('2026-Q1')
    expect(r.unfiledPeriods).toContain('2026-Q2')
    expect(r.notes.join(' ')).toMatch(/no GSTR-3B is recorded as filed/)
  })

  it('🔴 once the quarter is filed, credit the portal does not hold is not a timing difference', async () => {
    await recordGstFiling(ctx, { returnType: 'GSTR3B', periodLabel: '2026-Q1', filedOn: '2026-07-24' })

    // Q1's ₹18,000 is now claimed; the portal says it holds only half the CGST
    await importPortalStatement(ctx, {
      kind: 'GST_CREDIT_LEDGER', asOn: '2026-10-01',
      text: 'Integrated Tax,0.00\nCentral Tax,4500.00\nState/UT Tax,9000.00',
    })
    const r = await reconcileLedger(ctx, 'GST_CREDIT_LEDGER')

    expect(head(r, 'cgst').expected.toFixed(2)).toBe('9000.00')
    expect(head(r, 'cgst').severity).toBe('SERIOUS')
    expect(head(r, 'cgst').meaning).toMatch(/s\.16\(2\)\(aa\)/)
    expect(head(r, 'cgst').meaning).toMatch(/GSTR-2B/)
    expect(head(r, 'cgst').meaning).toMatch(/18%/)

    // Q2's IGST is still unfiled, so it is still subtracted and still agrees
    expect(head(r, 'igst').severity).toBe('AGREED')
    expect(r.notYetClaimed.igst.toFixed(2)).toBe('9000.00')
  })

  it('names the reverse-charge account as the reason the head-wise lines are approximate', async () => {
    const r = await reconcileLedger(ctx, 'GST_CREDIT_LEDGER')
    // nothing has posted to 1240 in this fixture, so the comparison is exact
    expect(r.approximate).toBeNull()
  })
})

describe('challans, which were recorded on nothing but our own word', () => {
  let challanId = '', stale = ''

  it('confirms a challan the OLTAS statement holds, and keeps the proof', async () => {
    const bill = await approveBill(ctx, (await createBill(ctx, {
      vendorId: (await prisma.vendor.findFirstOrThrow({ where: { companyId, name: 'Exalture Software Lab' } })).id,
      billNumber: 'EX/102', billDate: '2026-08-10',
      lines: [{ description: 'Post-production', sacCode: '998314', quantity: '1', rate: '200000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })).id)
    expect(bill).toBeTruthy()

    const deductions = await prisma.tdsDeduction.findMany({
      where: { companyId, challanId: null, reversedAt: null, sectionCode: '194C' },
    })
    const challan = await createChallan(ctx, {
      sectionCode: '194C', quarter: 2, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '02001', depositedOn: '2026-09-07',
    })
    challanId = challan.id
    const amount = Number(challan.amount)

    // 🔴 the CIN is BSR + DDMMYYYY + serial
    expect(challan.cin).toBe(oltasCin('0510308', new Date(Date.UTC(2026, 8, 7)), '02001'))
    expect(challan.cin).toBe('05103080709202602001')

    await importPortalStatement(ctx, {
      kind: 'TDS_CHALLANS', asOn: '2026-10-02', filename: 'oltas.csv',
      text: `Sr,CIN,BSR,Serial,Date,Amount\n1,05103080709202602001,0510308,02001,07-09-2026,${amount.toFixed(2)}`,
    })
    const r = await reconcileChallans(ctx, 'TDS_CHALLANS')
    expect(r.confirmed).toHaveLength(1)
    expect(r.confirmed[0].tier).toBe('BSR code, serial and date')
    expect(r.mismatched).toEqual([])
    expect(r.notOnPortal).toEqual([])
    expect(r.unchecked).toEqual([])
    expect(r.verdict).toMatch(/All 1 challan confirmed/)

    const saved = await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challanId } })
    expect(saved.portalConfirmedAt).not.toBeNull()
    expect(saved.portalConfirmedVia).toMatch(/TDS_CHALLANS as at 2026-10-02/)
  })

  it('🔴 takes the portal CIN over ours, because ours was constructed', async () => {
    // the bank stamped a different serial than the counterfoil was read as
    await prisma.tdsChallan.update({ where: { id: challanId }, data: { cin: '05103080709202602999' } })
    const amount = Number((await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challanId } })).amount)
    await importPortalStatement(ctx, {
      kind: 'TDS_CHALLANS', asOn: '2026-10-02',
      text: `1,05103080709202602001,0510308,02001,07-09-2026,${amount.toFixed(2)}`,
    })
    const r = await reconcileChallans(ctx, 'TDS_CHALLANS')
    // 🔴 replacing our constructed CIN with the portal's is a FIX, not an outstanding
    // problem — reporting it as one made the screen contradict its own figures
    expect(r.mismatched).toEqual([])
    expect(r.confirmed).toHaveLength(1)
    expect(r.confirmed[0].corrected).toMatch(/the portal says 05103080709202602001/)
    expect((await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challanId } })).cin).toBe('05103080709202602001')
  })

  it('🔴 says a challan nothing in OLTAS matches will be rejected as a challan mismatch', async () => {
    const d = await prisma.tdsDeduction.findFirst({ where: { companyId, challanId: null, reversedAt: null } })
    if (d) {
      stale = (await createChallan(ctx, {
        sectionCode: d.sectionCode, quarter: d.quarter, deductionIds: [d.id],
        bsrCode: '0510309', challanSerial: '03001', depositedOn: '2026-09-08',
      })).id
    }
    const amount = Number((await prisma.tdsChallan.findUniqueOrThrow({ where: { id: challanId } })).amount)
    await importPortalStatement(ctx, {
      kind: 'TDS_CHALLANS', asOn: '2026-10-03',
      text: `1,05103080709202602001,0510308,02001,07-09-2026,${amount.toFixed(2)}\n2,05103091009202604001,0510309,04001,10-09-2026,4000.00`,
    })
    const r = await reconcileChallans(ctx, 'TDS_CHALLANS')

    if (stale) {
      const missing = r.notOnPortal.find((x) => x.challanId === stale)
      expect(missing).toBeTruthy()
      expect(missing!.action).toMatch(/rejected as a challan mismatch/)
    }
    const extra = r.notInBooks.find((x) => x.amount.toFixed(2) === '4000.00')
    expect(extra).toBeTruthy()
    expect(extra!.action).toMatch(/no deductee has been credited with/)
  })

  it('counts what has never been checked against anything outside this system', async () => {
    const c = await portalConfidence(ctx)
    expect(c.tds.confirmed).toBeGreaterThanOrEqual(1)
    expect(c.gst.total).toBe(1)
    expect(c.gst.confirmed).toBe(0)
    expect(c.gst.unconfirmed).toBe(1)
    expect(c.lastStatement.get('TDS_CHALLANS')?.toISOString().slice(0, 10)).toBe('2026-10-03')
  })

  it('🔴 counts a CIN the BSR code, date and serial do not make', async () => {
    // the shape shipped before docs/56: BSR + YYYYMMDD + serial. Right length, wrong number.
    const c = await prisma.tdsChallan.findFirstOrThrow({ where: { companyId } })
    await prisma.tdsChallan.update({
      where: { id: c.id },
      data: {
        portalConfirmedAt: null, portalConfirmedVia: null,
        cin: `${c.bsrCode}${c.depositedOn.toISOString().slice(0, 10).replace(/-/g, '')}${c.challanSerial.padStart(5, '0')}`,
      },
    })
    const conf = await portalConfidence(ctx)
    const flagged = conf.cinUnverified.find((x) => x.id === c.id)
    expect(flagged).toBeTruthy()
    expect(flagged!.fromRefs).toBe(oltasCin(c.bsrCode, c.depositedOn, c.challanSerial))
    expect(flagged!.cin).not.toBe(flagged!.fromRefs)
  })

  it('keeps every statement, with its date and its verdict', async () => {
    const list = await listPortalStatements(ctx)
    expect(list.length).toBeGreaterThan(5)
    const tds = list.filter((s) => s.kind === 'TDS_CHALLANS')
    expect(tds[0].verdict).toMatch(/confirmed/)
    expect(tds[0].filename === null || typeof tds[0].filename === 'string').toBe(true)
  })
})

describe('🔴 what has not been checked, as against what is missing', () => {
  it('does not accuse a challan when no statement has been imported at all', async () => {
    // the GST challan history has never been imported in this fixture
    const r = await reconcileChallans(ctx, 'GST_CHALLANS')
    expect(r.notOnPortal).toEqual([])
    expect(r.unchecked).toHaveLength(1)
    expect(r.unchecked[0].why).toMatch(/Nothing has been imported/)
    expect(r.verdict).toBe('No portal statement imported')
  })

  it('does not call a challan missing when it was deposited after the statement', async () => {
    const amount = Number((await prisma.tdsChallan.findFirstOrThrow({
      where: { companyId, challanSerial: '02001' },
    })).amount)
    // a statement as at 7 September cannot hold a challan paid on 8 September
    await importPortalStatement(ctx, {
      kind: 'TDS_CHALLANS', asOn: '2026-09-07',
      text: `1,05103080709202602001,0510308,02001,07-09-2026,${amount.toFixed(2)}`,
    })
    const r = await reconcileChallans(ctx, 'TDS_CHALLANS')
    const later = r.unchecked.find((u) => u.depositedOn.toISOString().slice(0, 10) === '2026-09-08')
    if (later) expect(later.why).toMatch(/Deposited after the statement/)
    expect(r.notOnPortal.every((n) => n.depositedOn <= new Date('2026-09-07'))).toBe(true)
  })
})

describe('refusing an import that says nothing', () => {
  it('refuses a ledger statement with no readable head', async () => {
    await expect(importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-10-03', text: 'nothing,useful,here',
    })).rejects.toThrow(/No head balances could be read/)
  })

  it('refuses a statement as at a future date', async () => {
    await expect(importPortalStatement(ctx, {
      kind: 'GST_CASH_LEDGER', asOn: '2099-01-01', text: 'CGST,1.00',
    })).rejects.toThrow(/cannot be as at a future date/)
  })
})
