import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { randomUUID } from 'node:crypto'

export interface Parsed26asRow {
  deductorName: string
  deductorTan: string
  sectionCode: string
  amountPaid: Decimal
  tdsDeducted: Decimal
  dateOfDeduction: Date | null
  statusOfBooking: string | null
  quarter: number
}

export interface ParseResult {
  rows: Parsed26asRow[]
  skipped: { line: number; reason: string; raw: string }[]
  totalTds: Decimal
}

const TAN_RE = /\b([A-Z]{4}\d{5}[A-Z])\b/
const SECTION_RE = /\b(19[0-9][A-Z]?(?:\(\d+\))?|194[A-Z]{1,2})\b/

function toDecimal(v: string): Decimal | null {
  const cleaned = v.replace(/[₹,\s]/g, '')
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null
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
  return new Date(Date.UTC(year, mi, Number(d)))
}

/** Financial-year quarter: Q1 Apr–Jun … Q4 Jan–Mar. */
function quarterOf(d: Date): number {
  const m = d.getUTCMonth() + 1
  if (m >= 4 && m <= 6) return 1
  if (m >= 7 && m <= 9) return 2
  if (m >= 10) return 3
  return 4
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = !inQuotes }
    else if ((c === ',' || c === '\t' || c === '^') && !inQuotes) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * Form 26AS comes in several shapes — the portal's text export, the CSV, and whatever a
 * CA pastes into a spreadsheet. Rather than demand one layout, this reads each line
 * positionally: a TAN anchors the row, a section code identifies the nature of payment,
 * and the two largest money columns are the amount paid and the tax deducted.
 *
 * Anything it cannot read is REPORTED, never silently dropped — a skipped row is a
 * missing tax credit.
 */
export function parse26as(text: string, defaultQuarter?: number): ParseResult {
  const rows: Parsed26asRow[] = []
  const skipped: ParseResult['skipped'] = []

  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const tanMatch = TAN_RE.exec(trimmed.toUpperCase())
    if (!tanMatch) {
      // header rows and totals have no TAN — only report lines that look like data
      if (/\d{2,}/.test(trimmed) && splitCsvLine(trimmed).length > 3) {
        skipped.push({ line: i + 1, reason: 'No deductor TAN on the line', raw: trimmed.slice(0, 120) })
      }
      return
    }

    const cells = splitCsvLine(trimmed)
    const sectionMatch = SECTION_RE.exec(trimmed.toUpperCase())
    if (!sectionMatch) {
      skipped.push({ line: i + 1, reason: 'No section code recognised', raw: trimmed.slice(0, 120) })
      return
    }

    const amounts = cells.map(toDecimal).filter((d): d is Decimal => d !== null && d.gt(0))
    if (amounts.length < 2) {
      skipped.push({ line: i + 1, reason: 'Fewer than two amounts on the line', raw: trimmed.slice(0, 120) })
      return
    }
    const sorted = [...amounts].sort((a, b) => b.minus(a).toNumber())
    const amountPaid = sorted[0]
    const tdsDeducted = sorted.find((a) => !a.equals(amountPaid)) ?? sorted[1]

    const date = cells.map(toDate).find((d): d is Date => d !== null) ?? null
    const name = cells.find((c) => /[A-Za-z]{4,}/.test(c) && !TAN_RE.test(c.toUpperCase()) && !SECTION_RE.test(c.toUpperCase())) ?? 'Unknown deductor'
    const booking = cells.find((c) => /^[FOU]$/i.test(c)) ?? null

    rows.push({
      deductorName: name,
      deductorTan: tanMatch[1],
      sectionCode: sectionMatch[1],
      amountPaid,
      tdsDeducted,
      dateOfDeduction: date,
      statusOfBooking: booking ? booking.toUpperCase() : null,
      quarter: date ? quarterOf(date) : (defaultQuarter ?? 1),
    })
  })

  return { rows, skipped, totalTds: rows.reduce((a, r) => a.plus(r.tdsDeducted), ZERO) }
}

export async function import26as(ctx: RequestContext, text: string, financialYearId: string, defaultQuarter?: number) {
  assertCan(ctx.role, 'tax', 'write')
  const parsed = parse26as(text, defaultQuarter)
  if (parsed.rows.length === 0) {
    throw new AppError(`Nothing readable in that file — ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} could not be parsed. Expected rows carrying a deductor TAN, a section code and two amounts.`)
  }

  const importBatch = randomUUID()
  await prisma.$transaction(async (tx) => {
    // a re-import replaces the previous one for the year rather than doubling it
    await tx.form26asEntry.deleteMany({ where: { companyId: ctx.companyId, financialYearId } })
    for (const r of parsed.rows) {
      await tx.form26asEntry.create({
        data: {
          companyId: ctx.companyId, financialYearId, quarter: r.quarter,
          deductorTan: r.deductorTan, deductorName: r.deductorName, sectionCode: r.sectionCode,
          amountPaid: r.amountPaid.toFixed(2), tdsDeducted: r.tdsDeducted.toFixed(2),
          dateOfDeduction: r.dateOfDeduction, statusOfBooking: r.statusOfBooking,
          importBatch,
        },
      })
    }
  })
  await audit(ctx, { entity: 'Form26asEntry', entityId: importBatch, action: 'CREATE', after: { rows: parsed.rows.length, total: parsed.totalTds.toFixed(2) } })
  return { importBatch, ...parsed }
}

export interface ReconResult {
  matched: { receivableId: string; entryId: string; customerName: string; amount: Decimal; tier: string }[]
  missingIn26as: { receivableId: string; customerName: string; tan: string | null; quarter: number; section: string; amount: Decimal; action: string }[]
  notInBooks: { entryId: string; deductorName: string; tan: string; quarter: number; section: string; amount: Decimal; action: string }[]
  totals: { booked: Decimal; in26as: Decimal; matchedAmount: Decimal; missingAmount: Decimal; extraAmount: Decimal }
}

const TOLERANCE = new Decimal('1')

/**
 * Match what the books say against what the department has.
 *
 * Three tiers, loosest last. Everything unmatched on either side is reported with the
 * action it implies — a gap in 26AS means chasing the client; a row in 26AS with nothing
 * behind it usually means income that was never invoiced.
 */
export async function reconcile26as(ctx: RequestContext, financialYearId: string): Promise<ReconResult> {
  assertCan(ctx.role, 'tax', 'write')

  const [receivables, entries, customers] = await Promise.all([
    prisma.tdsReceivable.findMany({ where: { companyId: ctx.companyId, financialYearId } }),
    prisma.form26asEntry.findMany({ where: { companyId: ctx.companyId, financialYearId } }),
    prisma.customer.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true, tan: true } }),
  ])
  const custById = new Map(customers.map((c) => [c.id, c]))

  const usedEntries = new Set<string>()
  const usedReceivables = new Set<string>()
  const matched: ReconResult['matched'] = []

  const tanOf = (r: (typeof receivables)[number]) => r.deductorTan ?? custById.get(r.customerId)?.tan ?? null

  const tiers: { name: string; fits: (r: (typeof receivables)[number], e: (typeof entries)[number]) => boolean }[] = [
    { name: 'exact — TAN, section, quarter and amount',
      fits: (r, e) => tanOf(r) === e.deductorTan && r.sectionCode === e.sectionCode && r.quarter === e.quarter
        && new Decimal(r.tdsAmount.toString()).minus(e.tdsDeducted.toString()).abs().lte(TOLERANCE) },
    { name: 'section differs — the client filed it under another head',
      fits: (r, e) => tanOf(r) === e.deductorTan && r.quarter === e.quarter
        && new Decimal(r.tdsAmount.toString()).minus(e.tdsDeducted.toString()).abs().lte(TOLERANCE) },
    { name: 'quarter differs — the client filed it in a different quarter',
      fits: (r, e) => tanOf(r) === e.deductorTan && r.sectionCode === e.sectionCode
        && new Decimal(r.tdsAmount.toString()).minus(e.tdsDeducted.toString()).abs().lte(TOLERANCE) },
  ]

  for (const tier of tiers) {
    for (const r of receivables) {
      if (usedReceivables.has(r.id)) continue
      const e = entries.find((x) => !usedEntries.has(x.id) && tier.fits(r, x))
      if (!e) continue
      usedReceivables.add(r.id); usedEntries.add(e.id)
      matched.push({
        receivableId: r.id, entryId: e.id,
        customerName: custById.get(r.customerId)?.name ?? 'Unknown',
        amount: new Decimal(e.tdsDeducted.toString()), tier: tier.name,
      })
    }
  }

  // persist the outcome
  await prisma.$transaction(async (tx) => {
    for (const m of matched) {
      const e = entries.find((x) => x.id === m.entryId)!
      await tx.tdsReceivable.update({
        where: { companyId: ctx.companyId, id: m.receivableId },
        data: { status: 'MATCHED_26AS', form26asAmount: e.tdsDeducted, deductorTan: e.deductorTan },
      })
      await tx.form26asEntry.update({ where: { id: m.entryId }, data: { matchedReceivableId: m.receivableId } })
    }
    const unmatchedIds = receivables.filter((r) => !usedReceivables.has(r.id)).map((r) => r.id)
    if (unmatchedIds.length > 0) {
      await tx.tdsReceivable.updateMany({ where: { companyId: ctx.companyId, id: { in: unmatchedIds } }, data: { status: 'MISSING_IN_26AS', form26asAmount: null } })
    }
  })

  const missingIn26as = receivables.filter((r) => !usedReceivables.has(r.id)).map((r) => {
    const c = custById.get(r.customerId)
    return {
      receivableId: r.id,
      customerName: c?.name ?? 'Unknown',
      tan: tanOf(r),
      quarter: r.quarter,
      section: r.sectionCode,
      amount: new Decimal(r.tdsAmount.toString()),
      action: tanOf(r)
        ? `Ask ${c?.name ?? 'the client'} for Form 16A for Q${r.quarter}. Until this appears in 26AS it cannot be claimed in the ITR — it is lost, not deferred.`
        : `No TAN on record for ${c?.name ?? 'this client'}, so nothing can be matched. Get their TAN first.`,
    }
  })

  const notInBooks = entries.filter((e) => !usedEntries.has(e.id)).map((e) => ({
    entryId: e.id, deductorName: e.deductorName, tan: e.deductorTan, quarter: e.quarter,
    section: e.sectionCode, amount: new Decimal(e.tdsDeducted.toString()),
    action: `${e.deductorName} reported deducting ${formatINR(e.tdsDeducted.toString())} that is not in the books. Usually an invoice that was never raised, or a receipt not recorded — investigate before the ITR.`,
  }))

  const booked = receivables.reduce((a, r) => a.plus(r.tdsAmount.toString()), ZERO)
  const in26as = entries.reduce((a, e) => a.plus(e.tdsDeducted.toString()), ZERO)

  return {
    matched, missingIn26as, notInBooks,
    totals: {
      booked, in26as,
      matchedAmount: matched.reduce((a, m) => a.plus(m.amount), ZERO),
      missingAmount: missingIn26as.reduce((a, m) => a.plus(m.amount), ZERO),
      extraAmount: notInBooks.reduce((a, m) => a.plus(m.amount), ZERO),
    },
  }
}
