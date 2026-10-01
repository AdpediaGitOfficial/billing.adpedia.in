import { describe, it, expect } from 'vitest'
import { parseStatement, enrichNarration, dedupeHash, AXIS_PROFILE, HDFC_PROFILE } from '@/server/services/banking/parse'
import { Decimal } from '@/lib/money'

const AXIS_CSV = `
Statement of Axis Bank Account No : 921020015185413
Opening Balance: INR 47306.25

Transaction Date,Value Date,Particulars,Cheque Number,Amount(INR),Debit/Credit,Balance(INR),Branch Name(SOL)
04/02/2026,04/02/2026,NEFT/DH/AXODH03512206195/DEEPAK DAMODARAN/STATE BANK OF INDIA//////,,17500.00,DR,29806.25,CHALAKUDY
06/02/2026,06/02/2026,NEFT/HDFCH00786034370/KAYLA MAYOTECH LLP/HDFC BANK/0001Resource Payment,,18724.24,CR,48530.49,CHALAKUDY
09/02/2026,09/02/2026,INB/IFT/Shinelal/TPARTY TRANSFER,,2360.00,DR,46170.49,CHALAKUDY
21/02/2026,21/02/2026,Monthly Service Chrgs,,100.00,DR,46070.49,CHALAKUDY

Closing Balance: INR 46070.49
`.trim()

describe('Axis statement parsing', () => {
  it('reads every transaction with the right direction', () => {
    const r = parseStatement(AXIS_CSV, AXIS_PROFILE, 'bank1')
    expect(r.transactions).toHaveLength(4)
    expect(r.transactions[0]).toMatchObject({ direction: 'DEBIT' })
    expect(r.transactions[0].amount.toFixed(2)).toBe('17500.00')
    expect(r.transactions[1].direction).toBe('CREDIT')
    expect(r.periodFrom!.toISOString().slice(0, 10)).toBe('2026-02-04')
    expect(r.periodTo!.toISOString().slice(0, 10)).toBe('2026-02-21')
  })

  it('🔴 the balance check passes when the figures reconcile', () => {
    const r = parseStatement(AXIS_CSV, AXIS_PROFILE, 'bank1')
    expect(r.openingBalance!.toFixed(2)).toBe('47306.25')
    expect(r.closingBalance!.toFixed(2)).toBe('46070.49')
    expect(r.balanceCheck.ok).toBe(true)
    expect(r.balanceCheck.difference!.toFixed(2)).toBe('0.00')
  })

  it('🔴 rejects the batch when a row was read wrong', () => {
    // one amount corrupted — opening ± net no longer reaches closing
    const bad = AXIS_CSV.replace('17500.00,DR', '17000.00,DR')
    const r = parseStatement(bad, AXIS_PROFILE, 'bank1')
    expect(r.balanceCheck.ok).toBe(false)
    expect(r.balanceCheck.difference!.toFixed(2)).toBe('500.00')
  })

  it('reads an HDFC-style separate debit/credit layout', () => {
    const hdfc = `
Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
04/02/2026,NEFT-ABC CORP,N123,04/02/2026,0.00,50000.00,150000.00
05/02/2026,ATM CASH,,05/02/2026,2000.00,0.00,148000.00
`.trim()
    const r = parseStatement(hdfc, HDFC_PROFILE, 'bank2')
    expect(r.transactions).toHaveLength(2)
    expect(r.transactions[0].direction).toBe('CREDIT')
    expect(r.transactions[1].direction).toBe('DEBIT')
    expect(r.transactions[1].amount.toFixed(2)).toBe('2000.00')
  })

  it('reports rows it cannot read rather than dropping them', () => {
    const broken = AXIS_CSV.replace('17500.00,DR', ',')
    const r = parseStatement(broken, AXIS_PROFILE, 'bank1')
    expect(r.skipped.length).toBeGreaterThan(0)
    expect(r.skipped[0].reason).toMatch(/amount or direction/)
  })

  it('says so when there is no header it recognises', () => {
    const r = parseStatement('just\nsome\nrubbish', AXIS_PROFILE, 'bank1')
    expect(r.transactions).toHaveLength(0)
    expect(r.skipped[0].reason).toMatch(/No header row found/)
  })
})

describe('narration enrichment — docs/02 §H3', () => {
  it('pulls the UTR out of a NEFT narration', () => {
    const e = enrichNarration('NEFT/HDFCH00786034370/KAYLA MAYOTECH LLP/HDFC BANK/0001Resource Payment')
    expect(e.utr).toBe('HDFCH00786034370')
    expect(e.mode).toBe('NEFT')
    expect(e.counterparty).toBe('KAYLA MAYOTECH LLP')
  })

  it('pulls the RRN and the remark out of an IMPS narration', () => {
    const e = enrichNarration('IMPS/P2A/605108713778/SHINELAL/X111100/HDFCBANKLTD/Gstfeesf')
    expect(e.utr).toBe('605108713778')
    expect(e.mode).toBe('IMPS')
    expect(e.counterparty).toBe('SHINELAL')
    expect(e.remark).toBe('Gstfeesf')
  })

  it('reads an internal transfer', () => {
    const e = enrichNarration('INB/IFT/Praveen C D/TPARTY TRANSFER')
    expect(e.counterparty).toBe('Praveen C D')
    expect(e.mode).toBe('INB')
  })

  it('reads an outward NEFT through internet banking', () => {
    const e = enrichNarration('INB/NEFT/AXODH05170160988/Akash Raveendran/STATE BANK OF INDIA//////')
    expect(e.utr).toBe('AXODH05170160988')
    expect(e.counterparty).toBe('Akash Raveendran')
  })

  it('returns nulls for a bank charge rather than inventing a party', () => {
    const e = enrichNarration('Monthly Service Chrgs')
    expect(e.utr).toBeNull()
    expect(e.counterparty).toBeNull()
  })
})

describe('dedupe hash', () => {
  const base = { bankAccountId: 'b1', valueDate: new Date('2026-02-04'), amount: new Decimal('17500'), direction: 'DEBIT', narration: 'NEFT/DH/AXODH035/DEEPAK', refNo: 'AXODH035' }

  it('is stable for the same transaction', () => {
    expect(dedupeHash(base)).toBe(dedupeHash({ ...base }))
  })

  it('🔴 survives cosmetic changes in the narration', () => {
    // a re-export with different spacing or punctuation must still collide
    expect(dedupeHash({ ...base, narration: 'NEFT / DH / AXODH035 / DEEPAK' })).toBe(dedupeHash(base))
  })

  it('differs when anything material changes', () => {
    expect(dedupeHash({ ...base, amount: new Decimal('17500.01') })).not.toBe(dedupeHash(base))
    expect(dedupeHash({ ...base, direction: 'CREDIT' })).not.toBe(dedupeHash(base))
    expect(dedupeHash({ ...base, valueDate: new Date('2026-02-05') })).not.toBe(dedupeHash(base))
    expect(dedupeHash({ ...base, bankAccountId: 'b2' })).not.toBe(dedupeHash(base))
  })
})
