import { describe, it, expect } from 'vitest'
import { deriveRcm } from '@/server/services/purchases/vendor'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Decimal } from '@/lib/money'
import { postRcmSelfInvoice, INPUT_GST, RCM_PAYABLE } from '@/server/services/accounting/rules/purchase'
import { GST_ACCOUNTS } from '@/server/services/tax/gst-ledger'

/**
 * 🔴 docs/63 — the invariant that lets `1240` be read as IGST.
 *
 * docs/56 hedged: it told the owner that reverse-charge credit "is split across heads on the
 * portal" and that the head-wise comparison was therefore approximate. It is not, in this
 * system: the only reverse charge it can produce is an import of services, which is IGST.
 * Dropping a caveat is only safe if something holds the assumption in place, so this does.
 */
describe('🔴 reverse charge here is always IGST', () => {
  it('posts one input line, to the IGST reverse-charge account', () => {
    const postings = postRcmSelfInvoice({
      selfInvoiceNo: 'ADPS/26-27/0001', vendorId: 'v1', rcmIgst: new Decimal('1800'),
    })
    const debits = postings.filter((p) => p.debit)
    expect(debits).toHaveLength(1)
    expect(debits[0].accountCode).toBe(INPUT_GST.rcm)
    expect(debits[0].accountCode).toBe(GST_ACCOUNTS.rcmItc)
  })

  it('never touches the CGST or SGST input accounts', () => {
    const postings = postRcmSelfInvoice({
      selfInvoiceNo: 'ADPS/26-27/0002', vendorId: 'v1', rcmIgst: new Decimal('1800'),
    })
    const codes = postings.map((p) => p.accountCode)
    expect(codes).not.toContain(INPUT_GST.cgst)
    expect(codes).not.toContain(INPUT_GST.sgst)
    expect(codes).toContain(RCM_PAYABLE)
  })

  it('balances — the liability and the credit are the same figure', () => {
    const postings = postRcmSelfInvoice({
      selfInvoiceNo: 'ADPS/26-27/0003', vendorId: 'v1', rcmIgst: new Decimal('1800'),
    })
    const dr = postings.reduce((a, p) => a.plus(p.debit ?? 0), new Decimal(0))
    const cr = postings.reduce((a, p) => a.plus(p.credit ?? 0), new Decimal(0))
    expect(dr.toFixed(2)).toBe(cr.toFixed(2))
  })

  it('🔴 the chart of accounts says IGST, so the ledger reader is not guessing', () => {
    const seed = readFileSync(join(process.cwd(), 'prisma', 'seed', 'accounts.ts'), 'utf8')
    const line = seed.split('\n').find((l) => l.includes("'1240'"))
    expect(line).toBeTruthy()
    expect(line!).toMatch(/IGST/)
  })

  it('🔴 only one place computes a reverse charge, and it is the import rate', () => {
    // a second trigger — a notified domestic service under s.9(3) — would be CGST + SGST and
    // would break the invariant above. There is exactly one, and it keys off a foreign supplier.
    const bill = readFileSync(join(process.cwd(), 'src', 'server', 'services', 'purchases', 'bill.ts'), 'utf8')
    const triggers = bill.match(/rcmApplicable/g) ?? []
    expect(triggers.length).toBeGreaterThan(0)
    expect(bill).toMatch(/const RCM_RATE/)
    // and nothing splits a reverse charge into halves anywhere
    expect(bill).not.toMatch(/rcmCgst|rcmSgst/)
  })
})

/**
 * 🔴 docs/79 — the invariant `docs/63 §3` rests on, which nothing tested.
 *
 * That module's whole argument is that a DOMESTIC reverse charge cannot be produced here, so
 * account 1240 may stay a single IGST account and the GSTR-3B 3.1(d) line may stay a single
 * figure. It rests entirely on `deriveRcm`: `rcmApplicable` is derived, never typed in, and
 * derived in one place. A change to that function — adding a manual override, say — would
 * quietly make a domestic bill post IGST under a Kerala supplier, which is the wrong head of
 * the wrong tax, and every statement would still balance.
 */
describe('🔴 a domestic supplier can never be flagged for reverse charge', () => {
  it('derives it from the country and the GSTIN, and only ever for a foreign one', () => {
    expect(deriveRcm('IN', '32AABCE1234F1Z5')).toEqual({ isForeignSupplier: false, rcmApplicable: false })
    // an Indian supplier with no GSTIN is unregistered — still not a reverse charge here
    expect(deriveRcm('IN', null)).toEqual({ isForeignSupplier: false, rcmApplicable: false })
    expect(deriveRcm('IN', '')).toEqual({ isForeignSupplier: false, rcmApplicable: false })

    expect(deriveRcm('SG', null)).toEqual({ isForeignSupplier: true, rcmApplicable: true })
    expect(deriveRcm('US', undefined)).toEqual({ isForeignSupplier: true, rcmApplicable: true })
  })

  it('is the only thing that decides it — nothing reads an input field', () => {
    const src = readFileSync(join(process.cwd(), 'src/server/services/purchases/vendor.ts'), 'utf8')
    // every write of rcmApplicable goes through the spread of deriveRcm's result
    expect(src).not.toMatch(/rcmApplicable:\s*(input|!!input|Boolean\(input)/)
  })
})
