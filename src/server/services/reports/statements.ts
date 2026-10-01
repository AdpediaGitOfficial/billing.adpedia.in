import { Decimal, ZERO, sumBy } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { accountBalances, naturalBalance, type AccountBalance, type Period } from './ledger'

export interface TrialBalanceRow {
  code: string; name: string; type: string
  openingDr: Decimal; openingCr: Decimal
  debit: Decimal; credit: Decimal
  closingDr: Decimal; closingCr: Decimal
}

export interface TrialBalance {
  period: Period
  rows: TrialBalanceRow[]
  totals: { debit: Decimal; credit: Decimal; closingDr: Decimal; closingCr: Decimal }
  /** 🔴 if this is false the ledger is corrupt, not the report */
  balanced: boolean
  difference: Decimal
}

/** Split a signed natural balance back into the debit/credit columns a trial balance shows. */
function split(type: string, natural: Decimal): { dr: Decimal; cr: Decimal } {
  const debitNatured = type === 'ASSET' || type === 'EXPENSE'
  if (natural.isZero()) return { dr: ZERO, cr: ZERO }
  if (debitNatured) return natural.gt(0) ? { dr: natural, cr: ZERO } : { dr: ZERO, cr: natural.abs() }
  return natural.gt(0) ? { dr: ZERO, cr: natural } : { dr: natural.abs(), cr: ZERO }
}

export async function trialBalance(ctx: RequestContext, period: Period): Promise<TrialBalance> {
  const balances = await accountBalances(ctx, period)

  const rows: TrialBalanceRow[] = balances.map((b) => {
    const o = split(b.type, b.opening)
    const c = split(b.type, b.closing)
    return {
      code: b.code, name: b.name, type: b.type,
      openingDr: o.dr, openingCr: o.cr,
      debit: b.debit, credit: b.credit,
      closingDr: c.dr, closingCr: c.cr,
    }
  })

  const totals = {
    debit: sumBy(rows, (r) => r.debit),
    credit: sumBy(rows, (r) => r.credit),
    closingDr: sumBy(rows, (r) => r.closingDr),
    closingCr: sumBy(rows, (r) => r.closingCr),
  }
  const difference = totals.closingDr.minus(totals.closingCr)

  return { period, rows, totals, balanced: difference.isZero(), difference }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface PnlLine { code: string; name: string; amount: Decimal }
export interface PnlSection { label: string; lines: PnlLine[]; total: Decimal }

export interface ProfitAndLoss {
  period: Period
  revenue: PnlSection
  otherIncome: PnlSection
  directCosts: PnlSection
  operatingExpenses: PnlSection
  grossProfit: Decimal
  totalIncome: Decimal
  totalExpenses: Decimal
  netProfit: Decimal
  marginPct: Decimal | null
}

/** Direct cost = what was spent to deliver the work: people and subcontractors. */
const DIRECT_PREFIXES = ['51', '52']

/**
 * The P&L reads MOVEMENT only — income and expense accounts have no meaningful opening
 * balance within a year, because the year is the point at which they reset.
 */
export async function profitAndLoss(ctx: RequestContext, period: Period): Promise<ProfitAndLoss> {
  const balances = await accountBalances(ctx, period)

  const movement = (b: AccountBalance) => naturalBalance(b.type, b.debit, b.credit)
  const section = (label: string, picked: AccountBalance[]): PnlSection => {
    const lines = picked
      .map((b) => ({ code: b.code, name: b.name, amount: movement(b) }))
      .filter((l) => !l.amount.isZero())
      .sort((a, b) => a.code.localeCompare(b.code))
    return { label, lines, total: sumBy(lines, (l) => l.amount) }
  }

  const income = balances.filter((b) => b.type === 'INCOME')
  const expense = balances.filter((b) => b.type === 'EXPENSE')

  const revenue = section('Revenue', income.filter((b) => b.code.startsWith('40')))
  const otherIncome = section('Other income', income.filter((b) => !b.code.startsWith('40')))
  const directCosts = section('Direct costs', expense.filter((b) => DIRECT_PREFIXES.some((p) => b.code.startsWith(p))))
  const operatingExpenses = section('Operating expenses', expense.filter((b) => !DIRECT_PREFIXES.some((p) => b.code.startsWith(p))))

  const grossProfit = revenue.total.minus(directCosts.total)
  const totalIncome = revenue.total.plus(otherIncome.total)
  const totalExpenses = directCosts.total.plus(operatingExpenses.total)
  const netProfit = totalIncome.minus(totalExpenses)

  return {
    period, revenue, otherIncome, directCosts, operatingExpenses,
    grossProfit, totalIncome, totalExpenses, netProfit,
    marginPct: totalIncome.gt(0) ? netProfit.div(totalIncome).mul(100) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface BsLine { code: string; name: string; amount: Decimal; derived?: boolean }
export interface BsSection { label: string; lines: BsLine[]; total: Decimal }

export interface BalanceSheet {
  asOf: Date
  assets: BsSection
  liabilities: BsSection
  equity: BsSection
  totalAssets: Decimal
  totalLiabilitiesAndEquity: Decimal
  balanced: boolean
  difference: Decimal
  /** the P&L result folded into equity, shown so the number is never a mystery */
  currentYearProfit: Decimal
}

/**
 * 🔴 The trap this function exists to avoid.
 *
 * A balance sheet built by summing account balances DOES NOT BALANCE, and the reason
 * catches people out every time: income and expense accounts hold the year's profit, and
 * they are on neither side of the balance sheet. Until a year-end closing entry sweeps
 * them into retained earnings, the difference between assets and liabilities IS the
 * profit — so it has to be put back.
 *
 * Here it is computed from the same period's movement and shown as an explicit derived
 * line, `derived: true`, rather than posted. Nothing is written to account 3200: a
 * mid-year balance sheet must not fabricate journal entries, and the figure changes every
 * time a transaction is entered.
 */
export async function balanceSheet(ctx: RequestContext, asOf: Date, fyStart: Date): Promise<BalanceSheet> {
  // closing balances at the date — opening irrelevant, we want cumulative position
  const balances = await accountBalances(ctx, { from: new Date(0), to: asOf })

  const pick = (type: string): BsLine[] =>
    balances
      .filter((b) => b.type === type && !b.closing.isZero())
      .map((b) => ({ code: b.code, name: b.name, amount: b.closing }))
      .sort((a, b) => a.code.localeCompare(b.code))

  const assetLines = pick('ASSET')
  const liabilityLines = pick('LIABILITY')
  const equityLines = pick('EQUITY')

  // profit for the CURRENT year only; anything earlier already sits in retained earnings
  const pnl = await profitAndLoss(ctx, { from: fyStart, to: asOf })
  const currentYearProfit = pnl.netProfit

  // ...and any profit from BEFORE this financial year that was never closed out, which
  // would otherwise silently unbalance the statement.
  const priorPnl = await profitAndLoss(ctx, { from: new Date(0), to: new Date(fyStart.getTime() - 1) })

  if (!currentYearProfit.isZero()) {
    equityLines.push({ code: '3200', name: 'Current year profit', amount: currentYearProfit, derived: true })
  }
  if (!priorPnl.netProfit.isZero()) {
    equityLines.push({ code: '3100', name: 'Retained earnings — prior years (not yet closed)', amount: priorPnl.netProfit, derived: true })
  }

  const assets = { label: 'Assets', lines: assetLines, total: sumBy(assetLines, (l) => l.amount) }
  const liabilities = { label: 'Liabilities', lines: liabilityLines, total: sumBy(liabilityLines, (l) => l.amount) }
  const equity = { label: 'Equity', lines: equityLines, total: sumBy(equityLines, (l) => l.amount) }

  const totalLiabilitiesAndEquity = liabilities.total.plus(equity.total)
  const difference = assets.total.minus(totalLiabilitiesAndEquity)

  return {
    asOf, assets, liabilities, equity,
    totalAssets: assets.total, totalLiabilitiesAndEquity,
    balanced: difference.isZero(), difference,
    currentYearProfit,
  }
}
