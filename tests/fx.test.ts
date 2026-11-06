import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Decimal } from '@/lib/money'
import { toInr, inrOf, rateIsSet, parseFxRate, isForeign, formatDocAmount } from '@/lib/fx'
import { postInvoice } from '@/server/services/accounting/rules/invoice'

/** docs/91 — USD income booked in rupees. */

describe('lib/fx', () => {
  it('converts at the rate and rounds to the paisa once', () => {
    expect(toInr('250', '84.5').toFixed(2)).toBe('21125.00')
    expect(toInr('333.33', '83.4567').toFixed(2)).toBe('27818.62')
    expect(toInr('-50', '84').toFixed(2)).toBe('-4200.00')
  })

  it('inrOf leaves a rupee document alone, whatever its rate says', () => {
    expect(inrOf({ currency: 'INR', fxRate: '99' }, '1000').toFixed(2)).toBe('1000.00')
    expect(inrOf({ currency: 'USD', fxRate: '84' }, '10').toFixed(2)).toBe('840.00')
  })

  it('the default rate of 1 means "not entered" for a foreign document and nothing for a rupee one', () => {
    expect(rateIsSet('INR', '1')).toBe(true)
    expect(rateIsSet('USD', '1')).toBe(false)
    expect(rateIsSet('USD', '0')).toBe(false)
    expect(rateIsSet('USD', '84.25')).toBe(true)
    expect(rateIsSet('JPY', '0.56')).toBe(true)
  })

  it('parses only a positive number with at most six places', () => {
    expect(parseFxRate('84.25')?.toFixed(2)).toBe('84.25')
    expect(parseFxRate(' 0.560123 ')?.toFixed(6)).toBe('0.560123')
    for (const bad of ['', '  ', 'abc', '-1', '0', '0.0', '84,25', '1e3', '1.1234567', undefined, null]) {
      expect(parseFxRate(bad as string | null | undefined)).toBeNull()
    }
  })

  it('names a foreign amount in its own currency and a rupee one with the rupee sign', () => {
    expect(isForeign('INR')).toBe(false)
    expect(formatDocAmount('INR', '118000')).toBe('₹1,18,000.00')
    expect(formatDocAmount('USD', '6500')).toBe('USD 6,500.00')
  })
})

describe('postInvoice in a foreign currency', () => {
  const doc = (over: Partial<Parameters<typeof postInvoice>[0]> = {}) => ({
    number: 'X/1', customerId: 'c', grandTotal: new Decimal('0'), cgst: new Decimal(0), sgst: new Decimal(0),
    igst: new Decimal(0), roundOff: new Decimal(0), revenueByAccount: {}, ...over,
  })
  const net = (ps: ReturnType<typeof postInvoice>) =>
    ps.reduce((a, p) => a.plus(p.debit ?? 0).minus(p.credit ?? 0), new Decimal(0))

  it('books receivables as the sum of the converted parts, so the entry balances to the paisa', () => {
    // three income lines that each round differently at an awkward rate: converting the total
    // once would disagree with the sum of the three by a paisa
    const rate = new Decimal('83.456789')
    const revenue = { '4010': new Decimal('33.33'), '4020': new Decimal('66.67'), '4030': new Decimal('0.01') }
    const total = new Decimal('100.01')
    const ps = postInvoice(doc({ grandTotal: total, revenueByAccount: revenue, fxRate: rate }))
    expect(net(ps).toFixed(2)).toBe('0.00')
    const ar = ps.find((p) => p.accountCode === '1100')!
    expect(new Decimal(ar.debit as Decimal.Value).toFixed(2)).toBe(
      toInr('33.33', rate).plus(toInr('66.67', rate)).plus(toInr('0.01', rate)).toFixed(2),
    )
  })

  it('balances with a round-off loss and with GST as well', () => {
    const rate = new Decimal('84.1')
    for (const roundOff of ['-0.40', '0.40']) {
      const ps = postInvoice(doc({
        grandTotal: new Decimal('1180').plus(roundOff), roundOff: new Decimal(roundOff),
        igst: new Decimal('180'), revenueByAccount: { '4010': new Decimal('1000') }, fxRate: rate,
      }))
      expect(net(ps).toFixed(2)).toBe('0.00')
    }
  })

  it('without a rate it is exactly what it was', () => {
    const ps = postInvoice(doc({ grandTotal: new Decimal('118000'), cgst: new Decimal('9000'), sgst: new Decimal('9000'),
      revenueByAccount: { '4010': new Decimal('100000') } }))
    expect(new Decimal(ps.find((p) => p.accountCode === '1100')!.debit as Decimal.Value).toFixed(2)).toBe('118000.00')
    expect(net(ps).toFixed(2)).toBe('0.00')
  })
})

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

describe('docs/91 sweep: nothing adds an invoice\'s own-currency amounts into a rupee total', () => {
  const src = files('src')
  const text = new Map(src.map((f) => [f, readFileSync(f, 'utf8')]))

  it('sees the source, including the readers it is about', () => {
    expect(src.length).toBeGreaterThan(200)
    expect(text.get('src/server/services/dashboard.ts')).toContain('invoice.findMany')
    expect(text.get('src/server/services/sales/receivables.ts')).toContain('inrOf')
  })

  it('no database-side SUM over invoice money: a sum cannot apply each invoice\'s own rate', () => {
    const bad = src.filter((f) => /invoice\.(aggregate|groupBy)\s*\(([\s\S]{0,600}?)_sum\s*:/.test(text.get(f)!))
    expect(bad).toEqual([])
  })

  /**
   * Every file that reads invoices must either convert (import lib/fx) or be named here with
   * the reason it does not need to. A new report that does `invoice.findMany` and adds
   * `grandTotal` up arrives in none of these lists, and fails.
   */
  const NOT_AGGREGATING: Record<string, string> = {
    'src/app/(app)/dashboard/page.tsx': 'six recent invoices, shown one by one',
    'src/app/(app)/invoices/page.tsx': 'the list: one row each, and a rupee total taken from the ageing',
    'src/app/(app)/receipts/new/page.tsx': 'per-invoice outstanding, in the invoice\'s own currency, labelled',
    'src/app/(app)/settings/e-invoice/page.tsx': 'counts and statuses only',
    'src/server/services/banking/reconcile.ts': 'rupee invoices only — foreign ones are filtered out',
    'src/server/services/compliance/calendar.ts': 'selects dates',
    'src/server/services/invoicing/series-register.ts': 'document numbers and dates',
    'src/server/services/notify/schedule.ts': 'a message per invoice, no amount',
    'src/server/services/storage/document-archive.ts': 'which documents have a file on record',
  }
  it('every invoice reader converts to rupees or is listed as not summing', () => {
    const readers = src.filter((f) => /invoice\.findMany/.test(text.get(f)!))
    expect(readers.length).toBeGreaterThanOrEqual(15)
    const unaccounted = readers.filter((f) => !text.get(f)!.includes('@/lib/fx') && !(f in NOT_AGGREGATING))
    expect(unaccounted).toEqual([])
    // and the allow-list is not stale
    for (const f of Object.keys(NOT_AGGREGATING)) expect(text.has(f), f).toBe(true)
  })
})

describe('docs/93 sweep: nothing adds a vendor bill\'s own-currency amounts into a rupee total', () => {
  const src = files('src')
  const text = new Map(src.map((f) => [f, readFileSync(f, 'utf8')]))

  it('sees the bill readers it is about', () => {
    expect(text.get('src/server/services/purchases/payables.ts')).toContain('vendorBill.findMany')
    expect(text.get('src/server/services/tax/pan-register.ts')).toContain('inrOf')
  })

  it('no database-side SUM over vendor bills: a sum cannot apply each bill\'s own rate', () => {
    const bad = src.filter((f) => /vendorBill\.(aggregate|groupBy)\s*\(([\s\S]{0,600}?)_sum\s*:/.test(text.get(f)!))
    expect(bad).toEqual([])
  })

  const NOT_AGGREGATING: Record<string, string> = {
    'src/app/(app)/approvals/page.tsx': 'adds grandTotalInr, the rupee total the bill will be booked at',
    'src/server/services/banking/reconcile.ts': 'rupee bills only — foreign ones are filtered out',
    'src/server/services/compliance/chases.ts': 'selects the vendor to write to, no amount',
    'src/server/services/invoicing/series-register.ts': 'document numbers and dates',
    'src/server/services/tax/gstr2b.ts': 'credit-claiming bills only; a foreign bill claims none (reverse charge books its own credit)',
  }
  it('every bill reader converts to rupees or is listed as not summing', () => {
    const readers = src.filter((f) => /vendorBill\.findMany/.test(text.get(f)!))
    expect(readers.length).toBeGreaterThanOrEqual(8)
    const unaccounted = readers.filter((f) => !/@\/lib\/(fx|bill-fx)/.test(text.get(f)!) && !(f in NOT_AGGREGATING))
    expect(unaccounted).toEqual([])
    for (const f of Object.keys(NOT_AGGREGATING)) expect(text.has(f), f).toBe(true)
  })

  it('and pure helpers are right: the last payment settles exactly, the carry is proportional', async () => {
    const { clearedInr, carryingInr, billInr } = await import('@/lib/bill-fx')
    const D = (v: string) => new Decimal(v)
    expect(clearedInr(D('8400'), D('100'), D('40'), D('0'), false).toFixed(2)).toBe('3360.00')
    expect(clearedInr(D('8400'), D('100'), D('99.8'), D('3360'), true).toFixed(2)).toBe('5040.00')
    expect(carryingInr(D('8400'), D('100'), D('60')).toFixed(2)).toBe('5040.00')
    expect(carryingInr(D('8400'), D('100'), D('0')).toFixed(2)).toBe('0.00')
    const r = billInr({ costByAccount: { '5210': D('33.33'), '5220': D('66.67') }, cgst: D('0'), sgst: D('0'), igst: D('0') }, '83.456789')
    expect(r.grand.toFixed(2)).toBe(r.costByAccount['5210'].plus(r.costByAccount['5220']).toFixed(2))
  })
})
