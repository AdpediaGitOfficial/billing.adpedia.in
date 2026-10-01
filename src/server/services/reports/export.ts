import { csvRow, toCsv, csvMoney } from '@/lib/csv'
import type { TrialBalance, ProfitAndLoss, BalanceSheet } from './statements'
import type { CashFlow } from './cash-flow'
import type { Ageing } from './ageing'
import { BUCKETS } from './ageing'
import type { ClientPnlRow } from './client-pnl'

/**
 * CSV for the CA.
 *
 * Every file carries a header block naming the company, the statement and the period, so a
 * sheet that has been emailed on and renamed still says what it is. A statement without its
 * period is an unattributable list of numbers.
 */
interface Meta { company: string; gstin: string | null; period: string }

function header(m: Meta, title: string): string[] {
  return [
    csvRow([`# ${title}`]),
    csvRow(['# Company', m.company]),
    csvRow(['# GSTIN', m.gstin ?? '—']),
    csvRow(['# Period', m.period]),
    csvRow(['# Generated', new Date()]),
    '',
  ]
}

export function trialBalanceCsv(m: Meta, tb: TrialBalance): string {
  const out = header(m, 'Trial Balance')
  out.push(csvRow(['Code', 'Account', 'Type', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr']))
  for (const r of tb.rows) {
    out.push(csvRow([r.code, r.name, r.type,
      csvMoney(r.openingDr), csvMoney(r.openingCr), csvMoney(r.debit), csvMoney(r.credit),
      csvMoney(r.closingDr), csvMoney(r.closingCr)]))
  }
  out.push(csvRow(['', 'TOTAL', '', '', '',
    csvMoney(tb.totals.debit), csvMoney(tb.totals.credit),
    csvMoney(tb.totals.closingDr), csvMoney(tb.totals.closingCr)]))
  // the self-check travels with the file: a CA opening this should not have to re-add it
  out.push('', csvRow(['# Balanced', tb.balanced ? 'yes' : `NO — out by ${tb.difference.toFixed(2)}`]))
  return toCsv(out)
}

export function profitAndLossCsv(m: Meta, p: ProfitAndLoss): string {
  const out = header(m, 'Profit & Loss')
  out.push(csvRow(['Section', 'Code', 'Account', 'Amount']))
  const section = (s: { label: string; lines: { code: string; name: string; amount: { toFixed(n: number): string } }[]; total: { toFixed(n: number): string } }) => {
    for (const l of s.lines) out.push(csvRow([s.label, l.code, l.name, csvMoney(l.amount)]))
    out.push(csvRow([s.label, '', `Total ${s.label.toLowerCase()}`, csvMoney(s.total)]))
  }
  section(p.revenue)
  section(p.directCosts)
  out.push(csvRow(['', '', 'Gross profit', csvMoney(p.grossProfit)]))
  section(p.operatingExpenses)
  if (p.otherIncome.lines.length > 0) section(p.otherIncome)
  out.push('')
  out.push(csvRow(['', '', 'Total income', csvMoney(p.totalIncome)]))
  out.push(csvRow(['', '', 'Total expenses', csvMoney(p.totalExpenses)]))
  out.push(csvRow(['', '', 'Net profit', csvMoney(p.netProfit)]))
  return toCsv(out)
}

export function balanceSheetCsv(m: Meta, b: BalanceSheet): string {
  const out = header(m, 'Balance Sheet')
  out.push(csvRow(['Side', 'Code', 'Account', 'Amount', 'Note']))
  const side = (label: string, s: { lines: { code: string; name: string; amount: { toFixed(n: number): string }; derived?: boolean }[]; total: { toFixed(n: number): string } }) => {
    for (const l of s.lines) {
      // 🔴 the derived flag travels into the export: "calculated, not posted" is the whole
      // reason the statement balances, and a CA seeing 3200 with no journal behind it needs
      // to know that before they go looking for the entry
      out.push(csvRow([label, l.code, l.name, csvMoney(l.amount), l.derived ? 'calculated, not posted' : '']))
    }
    out.push(csvRow([label, '', `Total ${label.toLowerCase()}`, csvMoney(s.total), '']))
  }
  side('Assets', b.assets)
  side('Liabilities', b.liabilities)
  side('Equity', b.equity)
  out.push('')
  out.push(csvRow(['', '', 'Total assets', csvMoney(b.totalAssets), '']))
  out.push(csvRow(['', '', 'Total liabilities and equity', csvMoney(b.totalLiabilitiesAndEquity), '']))
  out.push(csvRow(['# Balanced', b.balanced ? 'yes' : `NO — out by ${b.difference.toFixed(2)}`]))
  return toCsv(out)
}

export function cashFlowCsv(m: Meta, cf: CashFlow): string {
  const out = header(m, 'Cash Flow (direct method)')
  out.push(csvRow(['Activity', 'Code', 'Account', 'In', 'Out', 'Net']))
  for (const s of cf.sections) {
    for (const l of s.lines) {
      out.push(csvRow([s.label, l.code, l.name, csvMoney(l.inflow), csvMoney(l.outflow), csvMoney(l.net)]))
    }
    out.push(csvRow([s.label, '', `Net cash from ${s.label.toLowerCase()}`, '', '', csvMoney(s.net)]))
  }
  out.push('')
  out.push(csvRow(['', '', 'Opening balance', '', '', csvMoney(cf.opening)]))
  out.push(csvRow(['', '', 'Net movement', '', '', csvMoney(cf.netChange)]))
  out.push(csvRow(['', '', 'Closing balance', '', '', csvMoney(cf.closing)]))
  out.push(csvRow(['# Ties to cash accounts', cf.reconciles ? 'yes' : `NO — out by ${cf.difference.toFixed(2)}`]))
  return toCsv(out)
}

export function ageingCsv(m: Meta, a: Ageing, side: 'Receivables' | 'Payables'): string {
  const out = header(m, `${side} Ageing`)
  out.push(csvRow(['Party', 'Document', 'Date', 'Due date', 'Days overdue', 'Bucket', 'Outstanding', 'TDS withheld']))
  for (const p of a.parties) {
    for (const d of p.docs) {
      out.push(csvRow([p.partyName, d.number, d.date, d.dueDate, d.daysOverdue, d.bucket,
        csvMoney(d.outstanding), csvMoney(d.tdsWithheld)]))
    }
  }
  out.push('')
  out.push(csvRow(['# Summary by bucket']))
  out.push(csvRow(['Party', ...BUCKETS, 'Total']))
  for (const p of a.parties) {
    out.push(csvRow([p.partyName, ...BUCKETS.map((b) => csvMoney(p.buckets[b])), csvMoney(p.total)]))
  }
  out.push(csvRow(['TOTAL', ...BUCKETS.map((b) => csvMoney(a.totals[b])), csvMoney(a.grandTotal)]))
  if (side === 'Receivables') {
    out.push('', csvRow(['# Excluded above — TDS clients must withhold, not a client debt', csvMoney(a.tdsWithheldTotal)]))
  }
  return toCsv(out)
}

export function clientPnlCsv(m: Meta, rows: ClientPnlRow[]): string {
  const out = header(m, 'Client P&L')
  out.push(csvRow(['Client', 'Projects', 'Revenue', 'Direct cost', 'Other cost', 'Total cost', 'Gross profit', 'Margin %', 'Outstanding']))
  for (const r of rows) {
    out.push(csvRow([r.name, r.projectCount, csvMoney(r.revenue), csvMoney(r.directCost),
      csvMoney(r.otherCost), csvMoney(r.totalCost), csvMoney(r.grossProfit),
      r.marginPct ? r.marginPct.toFixed(1) : '', csvMoney(r.outstanding)]))
  }
  return toCsv(out)
}
