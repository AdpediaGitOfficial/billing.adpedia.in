import { createHash } from 'node:crypto'
import { Decimal, ZERO } from '@/lib/money'

export interface ColumnMap {
  txnDate: string[]
  valueDate: string[]
  narration: string[]
  chequeNo?: string[]
  /** single signed column, or separate debit/credit columns */
  amount?: string[]
  debit?: string[]
  credit?: string[]
  direction?: string[]
  balance: string[]
}

export interface BankProfileSpec {
  name: string
  dateFormat: 'DD/MM/YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD'
  amountStyle: 'SEPARATE_DR_CR' | 'SIGNED_COLUMN' | 'AMOUNT_WITH_FLAG'
  columns: ColumnMap
}

/** docs/02 §H2 — derived from the real Axis export. */
export const AXIS_PROFILE: BankProfileSpec = {
  name: 'Axis Bank',
  dateFormat: 'DD/MM/YYYY',
  amountStyle: 'AMOUNT_WITH_FLAG',
  columns: {
    txnDate: ['transaction date', 'tran date', 'date'],
    valueDate: ['value date', 'value dt'],
    narration: ['particulars', 'narration', 'description'],
    chequeNo: ['cheque number', 'chq./ref.no.', 'cheque no'],
    amount: ['amount(inr)', 'amount'],
    direction: ['debit/credit', 'dr/cr', 'type'],
    balance: ['balance(inr)', 'balance', 'closing balance'],
  },
}

export const HDFC_PROFILE: BankProfileSpec = {
  name: 'HDFC Bank',
  dateFormat: 'DD/MM/YYYY',
  amountStyle: 'SEPARATE_DR_CR',
  columns: {
    txnDate: ['date'],
    valueDate: ['value dt', 'value date'],
    narration: ['narration'],
    chequeNo: ['chq./ref.no.'],
    debit: ['withdrawal amt.', 'withdrawal amount', 'debit'],
    credit: ['deposit amt.', 'deposit amount', 'credit'],
    balance: ['closing balance', 'balance'],
  },
}

export interface ParsedTxn {
  rowNumber: number
  txnDate: Date
  valueDate: Date
  amount: Decimal
  direction: 'DEBIT' | 'CREDIT'
  rawNarration: string
  chequeNo: string | null
  runningBalance: Decimal | null
  utr: string | null
  mode: string | null
  counterparty: string | null
  remark: string | null
  dedupeHash: string
}

export interface ParseReport {
  transactions: ParsedTxn[]
  skipped: { row: number; reason: string; raw: string }[]
  openingBalance: Decimal | null
  closingBalance: Decimal | null
  /** opening ± Σ(credits − debits) === closing */
  balanceCheck: { ok: boolean; expected: Decimal | null; actual: Decimal | null; difference: Decimal | null }
  periodFrom: Date | null
  periodTo: Date | null
}

function splitLine(line: string): string[] {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if ((c === ',' || c === '\t') && !q) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function parseDate(v: string, format: BankProfileSpec['dateFormat']): Date | null {
  const m = /(\d{1,4})[-/](\d{1,2}|\w{3})[-/](\d{2,4})/.exec(v.trim())
  if (!m) return null
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  let d: number, mo: number, y: number
  if (format === 'YYYY-MM-DD') { y = Number(m[1]); mo = Number(m[2]) - 1; d = Number(m[3]) }
  else {
    d = Number(m[1])
    mo = /^\d+$/.test(m[2]) ? Number(m[2]) - 1 : months.indexOf(m[2].toLowerCase().slice(0, 3))
    y = Number(m[3])
  }
  if (y < 100) y += 2000
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo, d))
}

function parseAmount(v: string): Decimal | null {
  const cleaned = v.replace(/[₹,\s]/g, '')
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return new Decimal(cleaned)
}

function findColumn(headers: string[], candidates: string[] | undefined): number {
  if (!candidates) return -1
  const lower = headers.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim())
  for (const c of candidates) {
    const i = lower.findIndex((h) => h === c || h.startsWith(c) || h.includes(c))
    if (i >= 0) return i
  }
  return -1
}

/* ── narration enrichment — docs/02 §H3 ──────────────────────────────────── */

const UTR_RE = /\b(?:AXODH|HDFCH|KKBKH|FBBT|EBIL|SBIN|ICIC|UTIB|PUNB|CNRB|IOBA|BARB)[A-Z0-9]{8,}\b/
const IMPS_RE = /IMPS\/P2A\/(\d{10,})/
const MODE_RE = /\b(NEFT|RTGS|IMPS|UPI|ACH|CHQ|CLG|CASH|INB|MOB|POS|EDC|ATM)\b/

export function enrichNarration(raw: string) {
  const upper = raw.toUpperCase()
  const utr = UTR_RE.exec(upper)?.[0] ?? IMPS_RE.exec(upper)?.[1] ?? null
  const mode = MODE_RE.exec(upper)?.[0] ?? null

  // the party sits between the reference and the bank name, varying by rail
  let counterparty: string | null = null
  let remark: string | null = null

  const patterns: RegExp[] = [
    /IMPS\/P2A\/\d{10,}\/([^/]+)\/[^/]*\/[^/]*\/?([^/]*)$/i,
    /IMPS\/P2A\/\d{10,}\/([^/]+)/i,
    /INB\/IFT\/([^/]+)\/TPARTY/i,
    /INB\/NEFT\/[A-Z0-9]+\/([^/]+)\//i,
    /NEFT\/[A-Z0-9]+\/([^/]+)\/[^/]*\/?(.*)$/i,
    /MOB\/TPFT\/([^/]+)\//i,
  ]
  for (const p of patterns) {
    const m = p.exec(raw)
    if (m) { counterparty = m[1].trim(); remark = (m[2] ?? '').trim() || null; break }
  }

  return {
    utr,
    mode,
    counterparty: counterparty ? counterparty.replace(/\s+/g, ' ').trim() : null,
    remark,
  }
}

/** Normalise for the dedupe hash so a re-export with cosmetic changes still collides. */
function normaliseNarration(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function dedupeHash(args: {
  bankAccountId: string; valueDate: Date; amount: Decimal; direction: string; narration: string; refNo: string | null
}) {
  return createHash('sha256').update([
    args.bankAccountId,
    args.valueDate.toISOString().slice(0, 10),
    args.amount.toFixed(2),
    args.direction,
    normaliseNarration(args.narration),
    args.refNo ?? '',
  ].join('|')).digest('hex')
}

/**
 * Parse a bank statement export.
 *
 * 🔴 The balance check is the whole point of the import step. If
 * opening ± Σ(credits − debits) ≠ closing, the file was read wrong and the batch is
 * rejected — cheap to compute, and it catches every parsing error before a single
 * wrong figure reaches the ledger (docs/02 §H2).
 */
export function parseStatement(
  text: string, profile: BankProfileSpec, bankAccountId: string,
  bounds?: { openingBalance?: string; closingBalance?: string },
): ParseReport {
  const lines = text.split(/\r?\n/)
  const skipped: ParseReport['skipped'] = []
  const transactions: ParsedTxn[] = []

  // find the header row — the first line carrying a recognisable date and narration column
  let headerIndex = -1, headers: string[] = []
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cells = splitLine(lines[i])
    if (cells.length < 3) continue
    if (findColumn(cells, profile.columns.narration) >= 0 && findColumn(cells, profile.columns.txnDate) >= 0) {
      headerIndex = i; headers = cells; break
    }
  }
  if (headerIndex < 0) {
    return {
      transactions: [], skipped: [{ row: 0, reason: `No header row found — expected a column matching one of: ${profile.columns.narration.join(', ')}`, raw: '' }],
      openingBalance: null, closingBalance: null,
      balanceCheck: { ok: false, expected: null, actual: null, difference: null },
      periodFrom: null, periodTo: null,
    }
  }

  const col = {
    txnDate: findColumn(headers, profile.columns.txnDate),
    valueDate: findColumn(headers, profile.columns.valueDate),
    narration: findColumn(headers, profile.columns.narration),
    chequeNo: findColumn(headers, profile.columns.chequeNo),
    amount: findColumn(headers, profile.columns.amount),
    debit: findColumn(headers, profile.columns.debit),
    credit: findColumn(headers, profile.columns.credit),
    direction: findColumn(headers, profile.columns.direction),
    balance: findColumn(headers, profile.columns.balance),
  }

  // opening / closing balance, if printed on the statement
  const balanceLine = (re: RegExp) => {
    for (const l of lines) { const m = re.exec(l); if (m) return parseAmount(m[1]) }
    return null
  }
  const openingBalance = bounds?.openingBalance ? parseAmount(bounds.openingBalance)
    : balanceLine(/opening balance[^0-9-]*([\d,.-]+)/i)
  let closingBalance = bounds?.closingBalance ? parseAmount(bounds.closingBalance)
    : balanceLine(/closing balance[^0-9-]*([\d,.-]+)/i)

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const cells = splitLine(line)
    if (cells.length < 3) continue

    const txnDate = col.txnDate >= 0 ? parseDate(cells[col.txnDate] ?? '', profile.dateFormat) : null
    if (!txnDate) continue   // totals, footers and legend lines carry no date

    const narration = (cells[col.narration] ?? '').trim()
    if (!narration) { skipped.push({ row: i + 1, reason: 'No narration', raw: line.slice(0, 120) }); continue }

    let amount: Decimal | null = null
    let direction: 'DEBIT' | 'CREDIT' | null = null

    if (profile.amountStyle === 'SEPARATE_DR_CR') {
      const d = col.debit >= 0 ? parseAmount(cells[col.debit] ?? '') : null
      const c = col.credit >= 0 ? parseAmount(cells[col.credit] ?? '') : null
      if (d && d.gt(0)) { amount = d; direction = 'DEBIT' }
      else if (c && c.gt(0)) { amount = c; direction = 'CREDIT' }
    } else if (profile.amountStyle === 'AMOUNT_WITH_FLAG') {
      amount = col.amount >= 0 ? parseAmount(cells[col.amount] ?? '') : null
      const flag = (cells[col.direction] ?? '').toUpperCase()
      direction = flag.startsWith('D') ? 'DEBIT' : flag.startsWith('C') ? 'CREDIT' : null
    } else {
      const signed = col.amount >= 0 ? parseAmount(cells[col.amount] ?? '') : null
      if (signed) { amount = signed.abs(); direction = signed.isNegative() ? 'DEBIT' : 'CREDIT' }
    }

    if (!amount || amount.lte(0) || !direction) {
      skipped.push({ row: i + 1, reason: 'No readable amount or direction', raw: line.slice(0, 120) })
      continue
    }

    const valueDate = col.valueDate >= 0 ? parseDate(cells[col.valueDate] ?? '', profile.dateFormat) ?? txnDate : txnDate
    const enriched = enrichNarration(narration)
    const chequeNo = col.chequeNo >= 0 ? (cells[col.chequeNo] || null) : null

    transactions.push({
      rowNumber: i + 1, txnDate, valueDate, amount, direction,
      rawNarration: narration, chequeNo,
      runningBalance: col.balance >= 0 ? parseAmount(cells[col.balance] ?? '') : null,
      ...enriched,
      dedupeHash: dedupeHash({ bankAccountId, valueDate, amount, direction, narration, refNo: enriched.utr ?? chequeNo }),
    })
  }

  // 🔴 the balance check
  const net = transactions.reduce(
    (a, t) => (t.direction === 'CREDIT' ? a.plus(t.amount) : a.minus(t.amount)), ZERO,
  )
  if (!closingBalance && transactions.length > 0) {
    closingBalance = transactions[transactions.length - 1].runningBalance
  }
  const expected = openingBalance ? openingBalance.plus(net) : null
  const difference = expected && closingBalance ? expected.minus(closingBalance) : null

  const dates = transactions.map((t) => t.txnDate.getTime())
  return {
    transactions, skipped, openingBalance, closingBalance,
    balanceCheck: {
      ok: difference ? difference.abs().lte('0.01') : false,
      expected, actual: closingBalance, difference,
    },
    periodFrom: dates.length ? new Date(Math.min(...dates)) : null,
    periodTo: dates.length ? new Date(Math.max(...dates)) : null,
  }
}
