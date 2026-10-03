import { csvRow, toCsv, csvMoney } from '@/lib/csv'
import type { TrialBalance, ProfitAndLoss, BalanceSheet } from './statements'
import type { CashFlow } from './cash-flow'
import type { Ageing } from './ageing'
import { BUCKETS } from './ageing'
import type { ClientPnlRow } from './client-pnl'
import type { JournalExport } from './journal-export'
import type { AccountBalance, LedgerLine } from './ledger'
import type { StatementStanding } from './status'

/**
 * CSV for the CA.
 *
 * Every file carries a header block naming the company, the statement and the period, so a
 * sheet that has been emailed on and renamed still says what it is. A statement without its
 * period is an unattributable list of numbers.
 */
interface Meta {
  company: string; gstin: string | null; period: string
  /**
   * 🔴 docs/58 — whether the books behind this file are closed, locked or still open.
   *
   * Every export before this said nothing about it. A profit figure for the year to date,
   * emailed to a bank in October, is not the year's profit, and a file that does not say so
   * is read as though it were final.
   */
  standing?: StatementStanding
}

function header(m: Meta, title: string): string[] {
  const out = [
    csvRow([`# ${title}`]),
    csvRow(['# Company', m.company]),
    csvRow(['# GSTIN', m.gstin ?? '—']),
    csvRow(['# Period', m.period]),
    csvRow(['# Generated', new Date()]),
  ]
  if (m.standing) {
    out.push(csvRow(['# Status', m.standing.label]), csvRow(['# ', m.standing.note]))
  }
  out.push('')
  return out
}

/**
 * The whole journal, line by line — the file an auditor asks for first.
 *
 * Both sides of every entry are present, so the file foots to zero on its own, and the
 * footer says whether it did. One row per LINE, not per entry: an entry with four lines is
 * four rows carrying the same entry number, which is what makes it sortable and pivotable.
 */
export function journalCsv(m: Meta, j: JournalExport): string {
  const out = header(m, 'Journal')
  out.push(csvRow([
    'Entry no', 'Date', 'Narration', 'Source', 'Source id', 'Reverses entry',
    'Account code', 'Account', 'Line narration', 'Debit', 'Credit', 'Project', 'Counterparty',
  ]))
  for (const l of j.lines) {
    out.push(csvRow([
      l.entryNo, l.date, l.narration, l.sourceType, l.sourceId ?? '', l.reversalOf ?? '',
      l.accountCode, l.accountName, l.lineNarration ?? '',
      csvMoney(l.debit), csvMoney(l.credit), l.project ?? '', l.counterparty ?? '',
    ]))
  }
  out.push(csvRow(['', '', `TOTAL — ${j.entries} entries, ${j.lines.length} lines`, '', '', '', '', '', '',
    csvMoney(j.totals.debit), csvMoney(j.totals.credit), '', '']))
  out.push('', csvRow(['# Balanced', j.balanced ? 'yes' : `NO — out by ${j.totals.debit.minus(j.totals.credit).toFixed(2)}`]))
  return toCsv(out)
}

/**
 * One account's ledger, with its opening balance and a running balance.
 *
 * 🔴 The opening balance is a row of its own, not a note. Without it the running balance in
 * the last column starts from a figure that is nowhere in the file, and every line of it
 * looks wrong to anybody checking the arithmetic.
 */
export function accountLedgerCsv(m: Meta, account: AccountBalance, lines: LedgerLine[]): string {
  const out = header(m, 'Account Ledger')
  // 🔴 the account's own cells, NOT interpolated into the title. An account name is
  // user-entered, and a value built into a title string has already escaped the one place
  // that escapes it — `csvCell`. Here it goes through the same guard as every other cell.
  out.splice(1, 0, csvRow(['# Account', account.code]), csvRow(['# Account name', account.name]))
  out.push(csvRow(['Date', 'Entry no', 'Narration', 'Line narration', 'Source', 'Debit', 'Credit', 'Balance']))
  out.push(csvRow(['', '', 'Opening balance', '', '', '', '', csvMoney(account.opening)]))
  for (const l of lines) {
    out.push(csvRow([l.date, l.entryNo, l.narration, l.lineNarration ?? '', l.sourceType,
      csvMoney(l.debit), csvMoney(l.credit), csvMoney(l.balance)]))
  }
  out.push(csvRow(['', '', 'Closing balance', '', '',
    csvMoney(account.debit), csvMoney(account.credit), csvMoney(account.closing)]))
  out.push('', csvRow(['# Balance direction', account.type === 'ASSET' || account.type === 'EXPENSE' ? 'debit' : 'credit']))
  return toCsv(out)
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
