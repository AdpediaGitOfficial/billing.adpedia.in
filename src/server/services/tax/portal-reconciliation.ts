import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { randomUUID } from 'node:crypto'
import type { PortalStatementKind } from '@prisma/client'
import { GST_ACCOUNTS, CASH_LEDGER_ACCOUNTS } from './gst-ledger'
import { periodsInFy } from './periods'
import { currentFinancialYear } from '@/server/services/accounting/period'
import { oltasCin } from './tds-challan'

/**
 * Reconciling with the portal — docs/56.
 *
 * Everything this system knows about the GST portal and about OLTAS it knows because
 * somebody typed it in. Both electronic ledgers are DERIVED from our own journal; every
 * challan reference was recorded on trust, and the TDS CIN is not even recorded — it is
 * constructed from the BSR code, the date and the serial. Nothing has ever been compared
 * with what the department actually holds.
 *
 * 🔴 There is no API call here and there never will be. docs/00 §6 rules out live filing,
 * so the portal's word arrives the way the CA's word arrives: as a statement a person
 * downloaded. The job of this module is to take that statement seriously — keep it with its
 * date, compare it head by head, and say what each difference MEANS, because the two sides
 * are not measuring the same thing and a naive subtraction is worse than no comparison.
 */

// ─────────────────────────────────────────────────────────────── parsing ──

export interface ParsedHead { head: string; balance: Decimal; raw: string }
export interface Skipped { line: number; reason: string; raw: string }

/**
 * 🔴 The portal names the major heads "Integrated Tax", "Central Tax" and "State/UT Tax".
 * All three contain the word "Tax", so anything matching loosely assigns the whole statement
 * to one head. A line that matches more than one keyword is a HEADER, not data — it is
 * either read positionally or reported, never assigned to the first match.
 */
const HEAD_WORDS: { head: string; words: RegExp }[] = [
  { head: 'igst', words: /\b(igst|integrated)\b/i },
  { head: 'cgst', words: /\b(cgst|central)\b/i },
  { head: 'sgst', words: /\b(sgst|sgst\/utgst|state|ut)\b/i },
  { head: 'other', words: /\b(interest|fee|penalty|other|cess)\b/i },
]

/** Column order in every portal ledger download: Integrated, Central, State/UT, Cess. */
const POSITIONAL = ['igst', 'cgst', 'sgst', 'other'] as const

function splitLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = !inQuotes }
    else if ((c === ',' || c === '\t' || c === '|' || c === ';') && !inQuotes) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function toDecimal(v: string): Decimal | null {
  const cleaned = v.replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  // a bare year or a long reference is not money
  if (/^\d{7,}$/.test(cleaned)) return null
  return new Decimal(cleaned)
}

function toDate(v: string): Date | null {
  const m = /(\d{1,2})[-/](\w{3}|\d{1,2})[-/](\d{2,4})/.exec(v.trim())
  if (!m) return null
  const [, d, mo, y] = m
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const mi = /^\d+$/.test(mo) ? Number(mo) - 1 : months.indexOf(mo.toLowerCase().slice(0, 3))
  if (mi < 0 || mi > 11) return null
  const year = y.length === 2 ? 2000 + Number(y) : Number(y)
  const day = Number(d)
  if (day < 1 || day > 31) return null
  return new Date(Date.UTC(year, mi, day))
}

/**
 * Read the closing balance of each major head out of a ledger statement.
 *
 * Two shapes are accepted, because both are what people actually have: one head and one
 * amount to a line, or the portal's own closing row carrying all four amounts in column
 * order. Anything else is REPORTED — a head read wrongly is a reconciliation that passes
 * while the books are out.
 */
export function parsePortalLedger(text: string): { heads: ParsedHead[]; skipped: Skipped[] } {
  const heads = new Map<string, ParsedHead>()
  const skipped: Skipped[] = []

  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const cells = splitLine(trimmed)
    const amounts = cells.map(toDecimal).filter((d): d is Decimal => d !== null)
    const matches = HEAD_WORDS.filter((h) => h.words.test(trimmed))

    if (amounts.length === 0) return  // a header or a title line carries no figures

    if (matches.length === 1 && amounts.length >= 1) {
      // one head named, one or more amounts — the LAST amount is the balance, because the
      // portal prints credited, debited and then balance
      const h = matches[0].head
      if (!heads.has(h)) heads.set(h, { head: h, balance: amounts[amounts.length - 1], raw: trimmed })
      return
    }

    if (amounts.length >= 3 && /balance|closing|total/i.test(trimmed)) {
      POSITIONAL.forEach((h, idx) => {
        const v = amounts[idx]
        if (v !== undefined && !heads.has(h)) heads.set(h, { head: h, balance: v, raw: trimmed })
      })
      return
    }

    skipped.push({
      line: i + 1,
      reason: matches.length > 1
        ? 'More than one major head named on the line, and no closing row to read positionally'
        : 'No major head named and no closing balance row recognised',
      raw: trimmed.slice(0, 120),
    })
  })

  return { heads: [...heads.values()], skipped }
}

export interface ParsedChallan {
  cin: string | null
  bsrCode: string | null
  challanSerial: string | null
  depositedOn: Date | null
  amount: Decimal
  raw: string
}

/**
 * A GST CIN is 17 characters and an OLTAS CIN is 20 — BSR(7) + DDMMYYYY(8) + serial(5).
 * 🔴 Deliberately wider than either: banks stamp their own longer references into the CIN
 * column, and a reference this cannot read is a challan this cannot confirm.
 */
const CIN_RE = /^[0-9A-Z]{14,24}$/
const BSR_RE = /^\d{7}$/

/**
 * Read a challan history, cell by cell.
 *
 * 🔴 Every cell is classified ONCE, and the amount is whatever is left. The naive version —
 * find the references, then take the biggest number on the line as the amount — reads the
 * challan serial `02001` as ₹2,001, because a serial is a number and looks exactly like
 * money. On a line with no amount column at all it then invents one.
 *
 * So: the CIN first (an OLTAS CIN *begins* with the BSR code, and looking for the BSR first
 * finds it inside the CIN and then looks for a serial inside the date), then the BSR, then
 * the date, then the serial — and money is only what no reference has claimed.
 */
export function parsePortalChallans(text: string): { rows: ParsedChallan[]; skipped: Skipped[] } {
  const rows: ParsedChallan[] = []
  const skipped: Skipped[] = []

  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const cells = splitLine(trimmed)
    const claimed = new Set<number>()
    const claim = (idx: number) => { if (idx >= 0) claimed.add(idx) }

    const cinIdx = cells.findIndex((c) => CIN_RE.test(c.toUpperCase()))
    const cin = cinIdx >= 0 ? cells[cinIdx].toUpperCase() : null
    claim(cinIdx)

    const oltas = cin !== null && cin.length === 20

    const bsrIdx = cells.findIndex((c, idx) => !claimed.has(idx) && BSR_RE.test(c))
    claim(bsrIdx)
    const bsrCode = bsrIdx >= 0 ? cells[bsrIdx] : oltas ? cin!.slice(0, 7) : null

    const dateIdx = cells.findIndex((c, idx) => !claimed.has(idx) && toDate(c) !== null)
    claim(dateIdx)
    const depositedOn = dateIdx >= 0
      ? toDate(cells[dateIdx])
      : oltas ? toDate(`${cin!.slice(7, 9)}-${cin!.slice(9, 11)}-${cin!.slice(11, 15)}`) : null

    // the counterfoil prints the serial zero-padded to five, so prefer exactly five digits.
    // 🔴 a shorter one is only accepted away from the first column, because column one of
    // every download anybody will paste is a serial NUMBER of rows, not the challan serial.
    let serialIdx = cells.findIndex((c, idx) => !claimed.has(idx) && /^\d{5}$/.test(c))
    if (serialIdx < 0) serialIdx = cells.findIndex((c, idx) => idx > 0 && !claimed.has(idx) && /^\d{1,5}$/.test(c) && c !== '0')
    claim(serialIdx)
    const challanSerial = oltas ? String(Number(cin!.slice(15, 20)))
      : serialIdx >= 0 ? cells[serialIdx] : null

    // money is what is left, and a figure with a decimal point is money for certain
    const free = cells.filter((_, idx) => !claimed.has(idx))
    const decimals = free.map(toDecimal).filter((d, idx) => d !== null && d.gt(0) && free[idx].includes('.')) as Decimal[]
    const wholes = free.map(toDecimal).filter((d): d is Decimal => d !== null && d.gt(0))
    const candidates = decimals.length > 0 ? decimals : wholes
    const amount = candidates.length > 0 ? candidates.reduce((a, b) => (b.gt(a) ? b : a)) : null

    if (!cin && !bsrCode) {
      if (/\d{2,}/.test(trimmed) && cells.length > 2) {
        skipped.push({ line: i + 1, reason: 'No CIN and no BSR code on the line', raw: trimmed.slice(0, 120) })
      }
      return
    }
    if (!amount) {
      skipped.push({ line: i + 1, reason: 'No amount on the line', raw: trimmed.slice(0, 120) })
      return
    }

    rows.push({ cin, bsrCode, challanSerial, depositedOn, amount, raw: trimmed.slice(0, 200) })
  })

  return { rows, skipped }
}

// ───────────────────────────────────────────────────────────── importing ──

export interface ImportInput {
  kind: PortalStatementKind
  /** the date the portal's figures are as at — NOT today */
  asOn: string
  text: string
  filename?: string
}

export async function importPortalStatement(ctx: RequestContext, input: ImportInput) {
  assertCan(ctx.role, 'tax', 'write')

  const asOn = new Date(input.asOn)
  if (Number.isNaN(asOn.getTime())) throw new AppError('Say what date the portal figures are as at')
  if (asOn.getTime() > Date.now() + 86_400_000) {
    throw new AppError('A statement cannot be as at a future date — use the date printed on the download')
  }

  const isLedger = input.kind === 'GST_CASH_LEDGER' || input.kind === 'GST_CREDIT_LEDGER'
  const importBatch = randomUUID()

  const ledger = isLedger ? parsePortalLedger(input.text) : null
  const challans = isLedger ? null : parsePortalChallans(input.text)

  if (ledger && ledger.heads.length === 0) {
    throw new AppError(
      `No head balances could be read from that statement${ledger.skipped.length ? `, and ${ledger.skipped.length} line${ledger.skipped.length === 1 ? '' : 's'} could not be parsed` : ''}. ` +
      'Each line needs one major head and its balance — or paste the closing row, which carries IGST, CGST, SGST and cess in that order.',
    )
  }
  if (challans && challans.rows.length === 0) {
    throw new AppError(
      `No challans could be read from that statement${challans.skipped.length ? `, and ${challans.skipped.length} line${challans.skipped.length === 1 ? '' : 's'} could not be parsed` : ''}. ` +
      'Each line needs a CIN or a 7-digit BSR code, and an amount.',
    )
  }

  const statement = await prisma.$transaction(async (tx) => {
    const s = await tx.portalStatement.create({
      data: {
        companyId: ctx.companyId, kind: input.kind, asOn,
        filename: input.filename ?? null, importBatch, importedById: ctx.userId,
      },
    })
    if (ledger) {
      for (const h of ledger.heads) {
        await tx.portalStatementLine.create({
          data: { statementId: s.id, companyId: ctx.companyId, head: h.head, balance: h.balance.toFixed(2), raw: h.raw },
        })
      }
    }
    if (challans) {
      for (const r of challans.rows) {
        await tx.portalStatementLine.create({
          data: {
            statementId: s.id, companyId: ctx.companyId,
            cin: r.cin, bsrCode: r.bsrCode, challanSerial: r.challanSerial,
            depositedOn: r.depositedOn, amount: r.amount.toFixed(2), raw: r.raw,
          },
        })
      }
    }
    return s
  })

  await audit(ctx, {
    entity: 'PortalStatement', entityId: statement.id, action: 'CREATE',
    after: { kind: input.kind, asOn: asOn.toISOString().slice(0, 10), rows: ledger?.heads.length ?? challans?.rows.length ?? 0 },
  })

  return {
    statement,
    rows: ledger?.heads.length ?? challans?.rows.length ?? 0,
    skipped: ledger?.skipped ?? challans?.skipped ?? [],
  }
}

export async function latestStatement(companyId: string, kind: PortalStatementKind) {
  return prisma.portalStatement.findFirst({
    where: { companyId, kind }, orderBy: [{ asOn: 'desc' }, { importedAt: 'desc' }], include: { lines: true },
  })
}

export async function listPortalStatements(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  const rows = await prisma.portalStatement.findMany({
    where: { companyId: ctx.companyId }, orderBy: [{ importedAt: 'desc' }], take: 20,
    include: { _count: { select: { lines: true } } },
  })
  return rows.map((r) => ({
    id: r.id, kind: r.kind, asOn: r.asOn, filename: r.filename,
    importedAt: r.importedAt, lines: r._count.lines, verdict: r.verdict,
  }))
}

// ──────────────────────────────────────────────── the ledger comparison ──

export type Severity = 'AGREED' | 'INVESTIGATE' | 'SERIOUS'

export interface HeadComparison {
  head: string
  label: string
  /** what our journal says the balance is */
  ours: Decimal
  /** what we would EXPECT the portal to hold, which is not always the same thing */
  expected: Decimal
  portal: Decimal | null
  difference: Decimal
  severity: Severity
  meaning: string | null
}

export interface LedgerReconciliation {
  kind: 'GST_CASH_LEDGER' | 'GST_CREDIT_LEDGER'
  title: string
  asOn: Date | null
  statementId: string | null
  heads: HeadComparison[]
  total: { ours: Decimal; expected: Decimal; portal: Decimal; difference: Decimal }
  /** credit accrued in periods whose GSTR-3B is not recorded as filed, head-wise */
  notYetClaimed: Record<string, Decimal>
  unfiledPeriods: string[]
  approximate: string | null
  notes: string[]
  verdict: string
}

const HEAD_LABELS: Record<string, string> = {
  igst: 'IGST', cgst: 'CGST', sgst: 'SGST', other: 'Interest, fee & penalty',
}

async function closingByAccount(companyId: string, codes: string[], asOn: Date) {
  const accounts = await prisma.account.findMany({
    where: { companyId, code: { in: codes } }, select: { id: true, code: true },
  })
  const rows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { companyId, date: { lte: asOn } } },
    _sum: { debit: true, credit: true },
  })
  const byId = new Map(rows.map((r) => [r.accountId, r._sum]))
  const out = new Map<string, Decimal>()
  for (const a of accounts) {
    const s = byId.get(a.id)
    const d = new Decimal(s?.debit?.toString() ?? '0'), c = new Decimal(s?.credit?.toString() ?? '0')
    out.set(a.code, d.minus(c))  // both are assets: debit in, credit out
  }
  for (const code of codes) if (!out.has(code)) out.set(code, ZERO)
  return out
}

/**
 * 🔴 Input credit accrues in our books the day a bill posts. It arrives in the PORTAL's
 * credit ledger only when a GSTR-3B claiming it is filed.
 *
 * So the two balances are not the same quantity, and expecting them to agree produces a
 * frightening difference every single month that means nothing. What has to be subtracted
 * first is the credit sitting in periods nobody has filed yet — and once that is done, what
 * remains is the difference that actually matters.
 */
async function creditNotYetClaimed(companyId: string, asOn: Date) {
  const fy = await currentFinancialYear(companyId, asOn)
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId }, select: { gstFilingFrequency: true },
  })
  const byHead: Record<string, Decimal> = { igst: ZERO, cgst: ZERO, sgst: ZERO, other: ZERO }
  const unfiled: string[] = []
  if (!fy) return { byHead, unfiled }

  const filed = new Set(
    (await prisma.gstReturnPeriod.findMany({
      where: { companyId, returnType: 'GSTR3B', status: 'FILED' }, select: { periodLabel: true },
    })).map((r) => r.periodLabel),
  )

  const codes = [GST_ACCOUNTS.inputIgst, GST_ACCOUNTS.inputCgst, GST_ACCOUNTS.inputSgst, GST_ACCOUNTS.rcmItc]
  const accounts = await prisma.account.findMany({
    where: { companyId, code: { in: codes } }, select: { id: true, code: true },
  })
  const headOf = new Map<string, string>([
    [GST_ACCOUNTS.inputIgst, 'igst'], [GST_ACCOUNTS.inputCgst, 'cgst'],
    [GST_ACCOUNTS.inputSgst, 'sgst'], [GST_ACCOUNTS.rcmItc, 'igst'],
  ])

  for (const p of periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)) {
    if (p.from > asOn) continue
    if (filed.has(p.label)) continue
    unfiled.push(p.label)
    const to = p.to < asOn ? p.to : asOn
    const rows = await prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        accountId: { in: accounts.map((a) => a.id) },
        journalEntry: { companyId, date: { gte: p.from, lte: to } },
      },
      _sum: { debit: true, credit: true },
    })
    for (const r of rows) {
      const code = accounts.find((a) => a.id === r.accountId)!.code
      const head = headOf.get(code)!
      const net = new Decimal(r._sum.debit?.toString() ?? '0').minus(r._sum.credit?.toString() ?? '0')
      byHead[head] = byHead[head].plus(net)
    }
  }
  return { byHead, unfiled }
}

/** Set-offs recorded here for a period whose GSTR-3B is not recorded as filed. */
async function setOffsWithoutFiling(companyId: string) {
  const [setOffs, filed] = await Promise.all([
    prisma.gstSetOff.findMany({
      where: { companyId, cancelledAt: null }, select: { periodLabel: true, cashUsed: true, creditUsed: true },
    }),
    prisma.gstReturnPeriod.findMany({
      where: { companyId, returnType: 'GSTR3B', status: 'FILED' }, select: { periodLabel: true },
    }),
  ])
  const filedSet = new Set(filed.map((f) => f.periodLabel))
  return setOffs.filter((s) => !filedSet.has(s.periodLabel))
}

export async function reconcileLedger(
  ctx: RequestContext,
  kind: 'GST_CASH_LEDGER' | 'GST_CREDIT_LEDGER',
  statementId?: string,
): Promise<LedgerReconciliation> {
  assertCan(ctx.role, 'tax', 'read')

  const statement = statementId
    ? await prisma.portalStatement.findFirstOrThrow({
        where: { id: statementId, companyId: ctx.companyId }, include: { lines: true },
      })
    : await latestStatement(ctx.companyId, kind)

  const asOn = statement?.asOn ?? null
  const at = asOn ?? new Date()
  const isCash = kind === 'GST_CASH_LEDGER'

  const codes = isCash
    ? [CASH_LEDGER_ACCOUNTS.igst, CASH_LEDGER_ACCOUNTS.cgst, CASH_LEDGER_ACCOUNTS.sgst, CASH_LEDGER_ACCOUNTS.other]
    : [GST_ACCOUNTS.inputIgst, GST_ACCOUNTS.inputCgst, GST_ACCOUNTS.inputSgst, GST_ACCOUNTS.rcmItc]
  const balances = await closingByAccount(ctx.companyId, codes, at)

  const ours: Record<string, Decimal> = isCash
    ? {
        igst: balances.get(CASH_LEDGER_ACCOUNTS.igst)!,
        cgst: balances.get(CASH_LEDGER_ACCOUNTS.cgst)!,
        sgst: balances.get(CASH_LEDGER_ACCOUNTS.sgst)!,
        other: balances.get(CASH_LEDGER_ACCOUNTS.other)!,
      }
    : {
        // 🔴 RCM credit is a separate ACCOUNT here (1240) and is NOT a separate head on the
        // portal: it is credited to IGST or to CGST+SGST according to the supply. One
        // account cannot say which, so it is folded into IGST and §approximate says so.
        igst: balances.get(GST_ACCOUNTS.inputIgst)!.plus(balances.get(GST_ACCOUNTS.rcmItc)!),
        cgst: balances.get(GST_ACCOUNTS.inputCgst)!,
        sgst: balances.get(GST_ACCOUNTS.inputSgst)!,
        other: ZERO,
      }

  const portalByHead = new Map<string, Decimal>()
  for (const l of statement?.lines ?? []) {
    if (l.head && l.balance !== null) portalByHead.set(l.head, new Decimal(l.balance.toString()))
  }

  const { byHead: notYetClaimed, unfiled } = isCash
    ? { byHead: { igst: ZERO, cgst: ZERO, sgst: ZERO, other: ZERO } as Record<string, Decimal>, unfiled: [] as string[] }
    : await creditNotYetClaimed(ctx.companyId, at)

  const unfiledSetOffs = isCash ? await setOffsWithoutFiling(ctx.companyId) : []

  const heads: HeadComparison[] = ['igst', 'cgst', 'sgst', 'other']
    .filter((h) => isCash || h !== 'other')
    .map((head) => {
      const o = ours[head] ?? ZERO
      const expected = o.minus(notYetClaimed[head] ?? ZERO)
      const portal = portalByHead.get(head) ?? null
      const difference = portal === null ? ZERO : portal.minus(expected)

      let severity: Severity = 'AGREED'
      let meaning: string | null = null

      if (!statement) {
        // 🔴 nothing has been imported, so there is nothing to disagree with. Scolding every
        // head for a statement that was never brought here reads as four real problems.
        meaning = null
      } else if (portal === null) {
        severity = 'INVESTIGATE'
        meaning = `The statement says nothing about ${HEAD_LABELS[head]}. A head missing from a download is not a head with a nil balance — check the statement covers all four.`
      } else if (difference.abs().lte('1')) {
        meaning = null
      } else if (isCash && difference.lt(0)) {
        severity = 'SERIOUS'
        meaning =
          `We hold ${formatINR(difference.abs())} of ${HEAD_LABELS[head]} that the portal has not credited. ` +
          (unfiledSetOffs.length > 0
            ? `A set-off is recorded for ${unfiledSetOffs.map((s) => s.periodLabel).join(', ')} with no GSTR-3B filed against it — if the return was never actually offset, this money is still sitting there and the liability is still live.`
            : 'Usually a challan generated and never paid: a CPIN with no CIN is an unpaid challan, and under rule 88B(1) interest runs until the cash ledger is actually debited.')
      } else if (isCash) {
        severity = 'INVESTIGATE'
        meaning =
          `The portal holds ${formatINR(difference)} of ${HEAD_LABELS[head]} the books do not know about — a deposit nobody recorded, ` +
          'or a set-off posted here that the portal never accepted. Either way the trial balance is understating an asset.'
      } else if (difference.lt(0)) {
        severity = 'SERIOUS'
        meaning =
          `${formatINR(difference.abs())} of ${HEAD_LABELS[head]} credit has been claimed that the portal does not hold. ` +
          'Under s.16(2)(aa) credit is not available at all unless the supplier declared the invoice and it appears in GSTR-2B — ' +
          'so this is not a timing difference. If it was claimed in a filed return it has to be reversed with interest at 18% under s.50(3) read with rule 88B(3).'
      } else {
        severity = 'INVESTIGATE'
        meaning =
          `The portal holds ${formatINR(difference)} more ${HEAD_LABELS[head]} credit than the books. ` +
          'Normally a vendor bill that was never entered — which means an expense missing from the P&L as well as the credit.'
      }

      return { head, label: HEAD_LABELS[head], ours: o, expected, portal, difference, severity, meaning }
    })

  const sumOf = (pick: (h: HeadComparison) => Decimal) => heads.reduce((a, h) => a.plus(pick(h)), ZERO as Decimal)
  const total = {
    ours: sumOf((h) => h.ours),
    expected: sumOf((h) => h.expected),
    portal: sumOf((h) => h.portal ?? ZERO),
    difference: sumOf((h) => h.difference),
  }

  const rcmItc = isCash ? ZERO : balances.get(GST_ACCOUNTS.rcmItc)!
  const approximate = !isCash && rcmItc.gt(0)
    ? `${formatINR(rcmItc)} of reverse-charge credit sits in one account here and is split across heads on the portal. ` +
      'The head-wise lines below are approximate while that is true; the total is exact.'
    : null

  const notes: string[] = []
  if (!statement) {
    notes.push('Nothing has been imported yet, so nothing is being compared — the figures below are only our own.')
  } else {
    notes.push(`Compared against the statement as at ${at.toISOString().slice(0, 10)}, not against today.`)
  }
  if (!isCash && unfiled.length > 0) {
    notes.push(
      `${formatINR(Object.values(notYetClaimed).reduce((a, v) => a.plus(v), ZERO as Decimal))} of credit sits in ${unfiled.join(', ')}, ` +
      'where no GSTR-3B is recorded as filed. The portal does not hold it yet and should not — it is subtracted before anything is called a difference.',
    )
  }
  if (isCash) {
    notes.push('The cash ledger has no timing difference to allow for: a challan credits it the day the bank confirms, and a set-off debits it. Both sides should agree to the rupee.')
  }

  const worst = heads.reduce<Severity>((a, h) => (
    h.severity === 'SERIOUS' || a === 'SERIOUS' ? 'SERIOUS'
      : h.severity === 'INVESTIGATE' || a === 'INVESTIGATE' ? 'INVESTIGATE' : a
  ), 'AGREED')

  const verdict = !statement
    ? 'No portal statement imported'
    : worst === 'AGREED'
      ? `Agrees with the portal as at ${at.toISOString().slice(0, 10)}`
      : `${heads.filter((h) => h.severity !== 'AGREED').length} of ${heads.length} heads differ — ${formatINR(total.difference.abs())} in total`

  return {
    kind, title: isCash ? 'Electronic cash ledger' : 'Electronic credit ledger',
    asOn, statementId: statement?.id ?? null,
    heads, total, notYetClaimed, unfiledPeriods: unfiled, approximate, notes, verdict,
  }
}

// ─────────────────────────────────────────────── the challan comparison ──

export interface ChallanMatch {
  challanId: string
  reference: string
  depositedOn: Date
  amount: Decimal
  portalAmount: Decimal | null
  tier: string
  /** the CIN the portal holds, where it differed from ours and replaced it */
  portalCin: string | null
  /**
   * 🔴 What this reconciliation PUT RIGHT, as against what it found wrong. Taking the
   * portal's CIN over our constructed one is a fix, and reporting it as an outstanding
   * problem made the screen contradict itself: the banner said "to look at" while the
   * figures above it already said "confirmed".
   */
  corrected: string | null
  problem: string | null
}

export interface ChallanReconciliation {
  kind: 'GST_CHALLANS' | 'TDS_CHALLANS'
  asOn: Date | null
  statementId: string | null
  confirmed: ChallanMatch[]
  mismatched: ChallanMatch[]
  /**
   * 🔴 Challans nothing has been compared against — either no statement was imported, or
   * they were deposited AFTER the one that was. They are not missing from the portal; the
   * portal has not been asked about them. Calling them missing accuses a challan that was
   * paid last week of never having been paid at all.
   */
  unchecked: { challanId: string; reference: string; depositedOn: Date; amount: Decimal; why: string }[]
  notOnPortal: { challanId: string; reference: string; depositedOn: Date; amount: Decimal; action: string }[]
  notInBooks: { raw: string; cin: string | null; depositedOn: Date | null; amount: Decimal; action: string }[]
  verdict: string
}

const RUPEE = new Decimal('1')

export async function reconcileChallans(
  ctx: RequestContext,
  kind: 'GST_CHALLANS' | 'TDS_CHALLANS',
  statementId?: string,
): Promise<ChallanReconciliation> {
  assertCan(ctx.role, 'tax', 'write')

  const statement = statementId
    ? await prisma.portalStatement.findFirstOrThrow({
        where: { id: statementId, companyId: ctx.companyId }, include: { lines: true },
      })
    : await latestStatement(ctx.companyId, kind)

  const isTds = kind === 'TDS_CHALLANS'
  const ours = isTds
    ? (await prisma.tdsChallan.findMany({
        where: { companyId: ctx.companyId, cancelledAt: null }, orderBy: { depositedOn: 'asc' },
      })).map((c) => ({
        id: c.id, cin: c.cin, bsrCode: c.bsrCode, challanSerial: c.challanSerial,
        depositedOn: c.depositedOn,
        amount: new Decimal(c.amount.toString()).plus(c.interest.toString()).plus(c.lateFee.toString()),
        reference: c.cin ?? `${c.bsrCode}/${c.challanSerial}`,
      }))
    : (await prisma.gstChallan.findMany({
        where: { companyId: ctx.companyId }, orderBy: { paidOn: 'asc' },
      })).map((c) => ({
        id: c.id, cin: c.cin, bsrCode: null as string | null, challanSerial: null as string | null,
        depositedOn: c.paidOn, amount: new Decimal(c.amount.toString()),
        reference: c.cin ?? c.cpin ?? c.periodLabel,
      }))

  const lines = (statement?.lines ?? []).filter((l) => l.amount !== null).map((l) => ({
    id: l.id, cin: l.cin, bsrCode: l.bsrCode, challanSerial: l.challanSerial,
    depositedOn: l.depositedOn, amount: new Decimal(l.amount!.toString()), raw: l.raw,
  }))

  type Ours = (typeof ours)[number]
  type Line = (typeof lines)[number]
  const sameDay = (a: Date | null, b: Date | null) =>
    a !== null && b !== null && a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)

  /**
   * 🔴 BSR code, serial and date first — not the CIN. The CIN is a derived string, and a
   * derived string that is one character out matches nothing while the challan underneath it
   * is plainly the same deposit. The references the bank actually stamped are the key.
   */
  const tiers: { name: string; fits: (o: Ours, l: Line) => boolean }[] = [
    {
      name: 'BSR code, serial and date',
      fits: (o, l) => o.bsrCode !== null && o.bsrCode === l.bsrCode
        && String(Number(o.challanSerial)) === String(Number(l.challanSerial))
        && sameDay(o.depositedOn, l.depositedOn),
    },
    { name: 'CIN', fits: (o, l) => o.cin !== null && l.cin !== null && o.cin === l.cin },
    {
      name: 'date and amount',
      fits: (o, l) => sameDay(o.depositedOn, l.depositedOn) && o.amount.minus(l.amount).abs().lte(RUPEE),
    },
  ]

  const usedLines = new Set<string>()
  const usedOurs = new Set<string>()
  const confirmed: ChallanMatch[] = []
  const mismatched: ChallanMatch[] = []

  for (const tier of tiers) {
    for (const o of ours) {
      if (usedOurs.has(o.id)) continue
      const l = lines.find((x) => !usedLines.has(x.id) && tier.fits(o, x))
      if (!l) continue
      usedOurs.add(o.id); usedLines.add(l.id)

      const amountOut = o.amount.minus(l.amount).abs().gt(RUPEE)
      const cinWrong = l.cin !== null && o.cin !== null && l.cin !== o.cin
      const match: ChallanMatch = {
        challanId: o.id, reference: cinWrong ? l.cin! : o.reference, depositedOn: o.depositedOn,
        amount: o.amount, portalAmount: l.amount, tier: tier.name,
        portalCin: cinWrong ? l.cin : null,
        corrected: cinWrong
          ? `The CIN on record was ${o.cin}; the portal says ${l.cin}, so that is what is on record now${isTds ? ' — the return quotes it' : ''}.`
          : null,
        problem: amountOut
          ? `The books say ${formatINR(o.amount)} and the portal says ${formatINR(l.amount)}. ` +
            (isTds
              ? 'A 26Q claiming more than the challan holds is a short-payment default against every deductee on it.'
              : 'The cash ledger will be credited with the portal figure, not ours.')
          : null,
      }
      if (match.problem) mismatched.push(match); else confirmed.push(match)
    }
  }

  // nothing can be absent from a statement that stops before it, or from no statement at all
  const after = (o: Ours) => statement !== null && o.depositedOn > statement.asOn
  const unchecked = ours.filter((o) => !usedOurs.has(o.id) && (!statement || after(o))).map((o) => ({
    challanId: o.id, reference: o.reference, depositedOn: o.depositedOn, amount: o.amount,
    why: !statement
      ? 'Nothing has been imported to check this against.'
      : `Deposited after the statement, which is as at ${statement.asOn.toISOString().slice(0, 10)} — download a later one.`,
  }))

  const notOnPortal = ours.filter((o) => !usedOurs.has(o.id) && statement !== null && !after(o)).map((o) => ({
    challanId: o.id, reference: o.reference, depositedOn: o.depositedOn, amount: o.amount,
    action: isTds
      ? `Nothing in OLTAS matches ${o.reference}. A 26Q quoting a CIN OLTAS does not hold is rejected as a challan mismatch, and until it is fixed the deductees get no credit — check the counterfoil before filing.`
      : `The portal's challan history has nothing matching ${o.reference}. A CPIN with no CIN is a challan generated and never paid: the cash ledger was never credited and the liability is still live.`,
  }))

  const notInBooks = lines.filter((l) => !usedLines.has(l.id)).map((l) => ({
    raw: l.raw, cin: l.cin, depositedOn: l.depositedOn, amount: l.amount,
    action: `${formatINR(l.amount)} was paid${l.depositedOn ? ` on ${l.depositedOn.toISOString().slice(0, 10)}` : ''} and is not in the books. ` +
      (isTds
        ? 'An unrecorded challan is tax deposited that no deductee has been credited with — link it to the deductions it covers.'
        : 'Record the challan, or the cash ledger here will stay short of the portal for ever.'),
  }))

  // 🔴 confirmation is PERSISTED, because the point is to be able to say later that it was
  // checked, and against what. The portal's CIN replaces ours where they differ: ours was
  // constructed, theirs was issued.
  if (statement && (confirmed.length > 0 || mismatched.length > 0)) {
    await prisma.$transaction(async (tx) => {
      const via = `${statement.kind} as at ${statement.asOn.toISOString().slice(0, 10)}`
      for (const m of [...confirmed, ...mismatched]) {
        const data: { portalConfirmedAt: Date; portalConfirmedVia: string; cin?: string } = {
          portalConfirmedAt: new Date(), portalConfirmedVia: via,
        }
        if (m.portalCin) data.cin = m.portalCin
        if (isTds) await tx.tdsChallan.update({ where: { id: m.challanId }, data })
        else await tx.gstChallan.update({ where: { id: m.challanId }, data })
      }
      const verdict = `${confirmed.length} confirmed, ${mismatched.length} mismatched, ${notOnPortal.length} not on the portal, ${notInBooks.length} not in the books`
      await tx.portalStatement.update({ where: { id: statement.id }, data: { verdict } })
    })
    await audit(ctx, {
      entity: 'PortalStatement', entityId: statement.id, action: 'UPDATE',
      after: { confirmed: confirmed.length, mismatched: mismatched.length, notOnPortal: notOnPortal.length },
    })
  }

  return {
    kind, asOn: statement?.asOn ?? null, statementId: statement?.id ?? null,
    confirmed, mismatched, unchecked, notOnPortal, notInBooks,
    verdict: !statement
      ? 'No portal statement imported'
      : mismatched.length === 0 && notOnPortal.length === 0 && notInBooks.length === 0
        ? `All ${confirmed.length} challan${confirmed.length === 1 ? '' : 's'} confirmed against the portal`
        : `${confirmed.length} confirmed · ${mismatched.length + notOnPortal.length + notInBooks.length} to look at`,
  }
}

/**
 * How much of what this system holds has ever been checked against anything outside it.
 *
 * 🔴 The honest headline is the count that has NOT been, because that is the number nobody
 * would otherwise see: a challan records itself as paid and then looks exactly like a
 * challan somebody verified.
 */
export async function portalConfidence(ctx: RequestContext) {
  assertCan(ctx.role, 'tax', 'read')
  const [tds, tdsConfirmed, gst, gstConfirmed, statements, tdsRows] = await Promise.all([
    prisma.tdsChallan.count({ where: { companyId: ctx.companyId, cancelledAt: null } }),
    prisma.tdsChallan.count({ where: { companyId: ctx.companyId, cancelledAt: null, portalConfirmedAt: { not: null } } }),
    prisma.gstChallan.count({ where: { companyId: ctx.companyId } }),
    prisma.gstChallan.count({ where: { companyId: ctx.companyId, portalConfirmedAt: { not: null } } }),
    prisma.portalStatement.findMany({
      where: { companyId: ctx.companyId }, orderBy: { asOn: 'desc' }, select: { kind: true, asOn: true },
    }),
    prisma.tdsChallan.findMany({
      where: { companyId: ctx.companyId, cancelledAt: null, portalConfirmedAt: null, cin: { not: null } },
      select: { id: true, cin: true, bsrCode: true, challanSerial: true, depositedOn: true },
    }),
  ])

  // 🔴 challans created before docs/56 carry a CIN built as BSR + YYYYMMDD + serial. It is
  // the right length and the wrong number, and the 26Q quotes it — so they are counted here
  // until somebody checks each against its counterfoil. A CIN a person typed in may also
  // differ legitimately, which is why this asks rather than corrects.
  const cinUnverified = tdsRows.filter((c) => c.cin !== oltasCin(c.bsrCode, c.depositedOn, c.challanSerial))
  const lastByKind = new Map<string, Date>()
  for (const s of statements) if (!lastByKind.has(s.kind)) lastByKind.set(s.kind, s.asOn)

  return {
    cinUnverified: cinUnverified.map((c) => ({
      id: c.id, cin: c.cin!, fromRefs: oltasCin(c.bsrCode, c.depositedOn, c.challanSerial),
      depositedOn: c.depositedOn,
    })),
    tds: { total: tds, confirmed: tdsConfirmed, unconfirmed: tds - tdsConfirmed },
    gst: { total: gst, confirmed: gstConfirmed, unconfirmed: gst - gstConfirmed },
    lastStatement: lastByKind,
  }
}
