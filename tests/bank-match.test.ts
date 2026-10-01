import { describe, it, expect } from 'vitest'
import { Decimal, ZERO } from '@/lib/money'
import { suggestMatches, nameSimilarity, type BankTxnFacts, type OpenInvoice, type OpenBill } from '@/server/services/banking/match'

const D = (v: string | number) => new Decimal(v)

const txn = (over: Partial<BankTxnFacts> = {}): BankTxnFacts => ({
  id: 't1', amount: D('91800'), direction: 'CREDIT', valueDate: new Date('2026-10-05'),
  rawNarration: 'NEFT/HDFCH00822263366/CLICK AR BUSINESS PRIVATE LI/HDFC BANK/0001',
  utr: 'HDFCH00822263366', counterparty: 'CLICK AR BUSINESS PRIVATE LI', remark: null, ...over,
})

const invoice = (over: Partial<OpenInvoice> = {}): OpenInvoice => ({
  id: 'i1', number: 'ADP/26-27/0026', customerId: 'c1',
  customerName: 'Click AR Business Private Limited', customerAliases: [],
  outstanding: D('100300'), tdsExpected: D('8500'), tdsSection: '194J',
  date: new Date('2026-09-30'), knownUtr: null, ...over,
})

describe('🔴 Tier 2 — the TDS-aware match', () => {
  it('matches ₹91,800 against a ₹1,00,300 invoice because the gap IS the TDS', () => {
    const s = suggestMatches({ txn: txn(), invoices: [invoice()], bills: [], rules: [] })
    expect(s[0].tier).toBe(2)
    expect(s[0].tierName).toBe('TDS-aware')
    expect(s[0].confidence).toBe(92)
    expect(s[0].reason).toMatch(/plus ₹8,500.00 of TDS u\/s 194J settles ADP\/26-27\/0026 exactly/)

    const sug = s[0].suggestion
    expect(sug.kind).toBe('RECEIPT')
    if (sug.kind === 'RECEIPT') {
      expect(sug.allocations[0].amount.toFixed(2)).toBe('91800.00')
      expect(sug.allocations[0].tds.toFixed(2)).toBe('8500.00')
    }
  })

  it('works for 194C at 2% as well', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('98600') }),
      invoices: [invoice({ tdsExpected: D('1700'), tdsSection: '194C' })],
      bills: [], rules: [],
    })
    expect(s[0].tier).toBe(2)
    expect(s[0].reason).toMatch(/194C/)
  })

  it('does not fire when the shortfall is not the TDS', () => {
    const s = suggestMatches({ txn: txn({ amount: D('70000') }), invoices: [invoice()], bills: [], rules: [] })
    expect(s.find((x) => x.tier === 2)).toBeUndefined()
  })
})

describe('Tier 0 and 1', () => {
  it('a known UTR is unambiguous', () => {
    const s = suggestMatches({ txn: txn(), invoices: [invoice({ knownUtr: 'HDFCH00822263366' })], bills: [], rules: [] })
    expect(s[0].tier).toBe(0)
    expect(s[0].confidence).toBe(100)
    expect(s[0].reason).toMatch(/no ambiguity/)
  })

  it('an exact amount settles in full', () => {
    const s = suggestMatches({ txn: txn({ amount: D('100300') }), invoices: [invoice({ tdsExpected: ZERO })], bills: [], rules: [] })
    expect(s[0].tier).toBe(1)
    expect(s[0].reason).toMatch(/settles ADP\/26-27\/0026 in full/)
  })
})

describe('Tier 3 — charges on the way in', () => {
  it('absorbs an intermediary charge on an export receipt', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('84500'), counterparty: 'NUVE HOLDINGS FZ LLC' }),
      invoices: [invoice({ number: 'ADPX/26-27/0001', customerName: 'Nuvé Holdings FZ-LLC', outstanding: D('85000'), tdsExpected: ZERO, isExport: true })],
      bills: [], rules: [],
    })
    expect(s[0].tier).toBe(3)
    expect(s[0].reason).toMatch(/₹500.00 short.*correspondent and intermediary bank charges/)
    if (s[0].suggestion.kind === 'RECEIPT') expect(s[0].suggestion.bankCharge.toFixed(2)).toBe('500.00')
  })

  it('🔴 does NOT absorb the same gap on a domestic receipt', () => {
    // a rupee NEFT arrives whole — the sender pays the charge — so ₹500 missing is not a fee
    const s = suggestMatches({
      txn: txn({ amount: D('84500') }),
      invoices: [invoice({ outstanding: D('85000'), tdsExpected: ZERO })],
      bills: [], rules: [],
    })
    expect(s.find((x) => x.tier === 3)).toBeUndefined()
  })

  it('refuses a gap too large to be a charge', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('60000') }),
      invoices: [invoice({ outstanding: D('85000'), tdsExpected: ZERO })],
      bills: [], rules: [],
    })
    expect(s.find((x) => x.tier === 3)).toBeUndefined()
  })
})

describe('Tier 4 — splits and combinations', () => {
  it('one receipt covering two invoices', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('500000') }),
      invoices: [
        invoice({ id: 'a', number: 'ADP/26-27/0041', outstanding: D('236000'), tdsExpected: ZERO }),
        invoice({ id: 'b', number: 'ADP/26-27/0047', outstanding: D('264000'), tdsExpected: ZERO }),
      ],
      bills: [], rules: [],
    })
    const combo = s.find((x) => x.tierName === 'Combined receipt')
    expect(combo).toBeTruthy()
    expect(combo!.reason).toMatch(/ADP\/26-27\/0041.*\+.*ADP\/26-27\/0047/)
    if (combo!.suggestion.kind === 'RECEIPT') expect(combo!.suggestion.allocations).toHaveLength(2)
  })

  it('a part payment leaves the balance named', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('50000') }),
      invoices: [invoice({ outstanding: D('100300'), tdsExpected: ZERO })],
      bills: [], rules: [],
    })
    const part = s.find((x) => x.tierName === 'Part payment')
    expect(part!.reason).toMatch(/leaving ₹50,300.00 outstanding/)
  })
})

describe('Tier 5 and 6', () => {
  it('recognises the party but suggests an advance when nothing fits', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('250000') }),
      invoices: [invoice({ outstanding: D('1000'), tdsExpected: ZERO })],
      bills: [], rules: [],
    })
    const adv = s.find((x) => x.tier === 5)
    expect(adv).toBeTruthy()
    expect(adv!.reason).toMatch(/an advance, or an invoice not yet raised/)
  })

  it('applies a learned rule', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('100'), direction: 'DEBIT', rawNarration: 'Monthly Service Chrgs', counterparty: null, utr: null }),
      invoices: [], bills: [],
      rules: [{ id: 'r1', pattern: 'Monthly Service Chrgs', matchType: 'CONTAINS', direction: 'DEBIT', accountCode: '5600', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Bank charges' }],
    })
    expect(s[0].tier).toBe(6)
    expect(s[0].confidence).toBe(95)
    if (s[0].suggestion.kind === 'LEDGER') expect(s[0].suggestion.accountCode).toBe('5600')
  })

  it('🔴 fires only the most specific rule when patterns overlap', () => {
    // "GST @18% on Monthly Service Chrgs" contains BOTH patterns. Picking the bank-charge
    // rule would post the input credit to an expense account and forfeit it silently.
    const rules = [
      { id: 'r1', pattern: 'Monthly Service Chrgs', matchType: 'CONTAINS' as const, direction: 'DEBIT' as const, accountCode: '5600', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Bank charges' },
      { id: 'r2', pattern: 'GST @18% on', matchType: 'CONTAINS' as const, direction: 'DEBIT' as const, accountCode: '1210', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Input GST on bank charges' },
    ]
    const s = suggestMatches({
      txn: txn({ amount: D('18'), direction: 'DEBIT', rawNarration: 'GST @18% on Monthly Service Chrgs', counterparty: null, utr: null }),
      invoices: [], bills: [], rules,
    })
    const ledger = s.filter((x) => x.tier === 6)
    expect(ledger).toHaveLength(1)
    if (ledger[0].suggestion.kind === 'LEDGER') expect(ledger[0].suggestion.accountCode).toBe('1210')

    // and the plain charge line still reaches the charge account
    const plain = suggestMatches({
      txn: txn({ amount: D('100'), direction: 'DEBIT', rawNarration: 'Monthly Service Chrgs', counterparty: null, utr: null }),
      invoices: [], bills: [], rules,
    }).filter((x) => x.tier === 6)
    expect(plain).toHaveLength(1)
    if (plain[0].suggestion.kind === 'LEDGER') expect(plain[0].suggestion.accountCode).toBe('5600')
  })

  it('🔴 pairs a contra so a transfer is never counted as income and expense', () => {
    const out = txn({ id: 'a', amount: D('50000'), direction: 'DEBIT' })
    const back = txn({ id: 'b', amount: D('50000'), direction: 'CREDIT', valueDate: new Date('2026-10-06') })
    const s = suggestMatches({ txn: out, invoices: [], bills: [], rules: [], siblings: [back] })
    const contra = s.find((x) => x.tierName === 'Contra')
    expect(contra).toBeTruthy()
    expect(contra!.reason).toMatch(/not income or expense/)
  })
})

describe('vendor payments', () => {
  const bill = (over: Partial<OpenBill> = {}): OpenBill => ({
    id: 'b1', billNumber: 'EX/2026/114', vendorId: 'v1',
    vendorName: 'Exalture Software Lab', vendorAliases: [], outstanding: D('232000'),
    dueDate: new Date('2026-09-23'), ...over,
  })

  it('matches a payment net of the TDS withheld', () => {
    const s = suggestMatches({
      txn: txn({ amount: D('232000'), direction: 'DEBIT', counterparty: 'EXALTURE SOFTWARE LAB', rawNarration: 'INB/NEFT/AXODH18223/EXALTURE SOFTWARE LAB/ICICI BANK' }),
      invoices: [], bills: [bill()], rules: [],
    })
    expect(s[0].tier).toBe(1)
    expect(s[0].reason).toMatch(/net of the TDS withheld/)
  })
})

describe('party matching', () => {
  it('tolerates the truncation banks apply to names', () => {
    expect(nameSimilarity('CLICK AR BUSINESS PRIVATE LI', 'Click AR Business Private Limited')).toBeGreaterThan(0.7)
    expect(nameSimilarity('EXALTURE SOFTWARE LAB', 'Exalture Software Lab')).toBe(1)
  })

  it('does not confuse unrelated parties', () => {
    expect(nameSimilarity('DEEPAK DAMODARAN', 'Click AR Business Private Limited')).toBe(0)
  })
})
