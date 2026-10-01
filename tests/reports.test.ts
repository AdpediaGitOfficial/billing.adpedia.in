import { describe, it, expect } from 'vitest'
import { Decimal, ZERO } from '@/lib/money'
import { naturalBalance, isDebitNatured } from '@/server/services/reports/ledger'

const D = (v: string) => new Decimal(v)

describe('natural balance direction', () => {
  it('assets and expenses are debit-natured, the rest credit-natured', () => {
    expect(isDebitNatured('ASSET')).toBe(true)
    expect(isDebitNatured('EXPENSE')).toBe(true)
    expect(isDebitNatured('LIABILITY')).toBe(false)
    expect(isDebitNatured('EQUITY')).toBe(false)
    expect(isDebitNatured('INCOME')).toBe(false)
  })

  it('🔴 signs a balance so a healthy account always reads positive', () => {
    // a bank account with money in it: debits exceed credits
    expect(naturalBalance('ASSET', D('100000'), D('40000')).toString()).toBe('60000')
    // a payable that is owed: credits exceed debits — still positive, because that is
    // the natural state of a liability. Reporting it as -60000 would be arithmetically
    // true and completely unreadable.
    expect(naturalBalance('LIABILITY', D('40000'), D('100000')).toString()).toBe('60000')
    // revenue earned
    expect(naturalBalance('INCOME', ZERO, D('85000')).toString()).toBe('85000')
  })

  it('goes negative when an account is genuinely the wrong way round', () => {
    // an overdrawn bank account is a real condition and must not be hidden
    expect(naturalBalance('ASSET', D('10000'), D('25000')).toString()).toBe('-15000')
  })
})
