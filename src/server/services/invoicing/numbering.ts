import type { Tx } from '@/server/db'
import type { DocType } from '@prisma/client'
import { NotFound, AppError } from '@/server/errors'
import { shortFy } from '@/lib/fy'

/**
 * 🔴 Non-negotiable #3 (docs/10 §3.3).
 *
 * The number is allocated by the DATABASE, inside the transaction that creates the
 * document, under SELECT … FOR UPDATE on the series row. Never by application code,
 * never typed by a person.
 *
 * Adpedia issued invoice number 11 twice by hand (docs/03 §2.1). That is what this
 * prevents — two concurrent creates block on the same row and come out sequential.
 *
 * MUST be called inside prisma.$transaction, or the lock has no scope to hold.
 */
export async function allocateNumber(
  tx: Tx,
  args: { companyId: string; financialYearId: string; docType: DocType; fyLabel: string },
): Promise<{ number: string; seq: number }> {
  const rows = await tx.$queryRaw<{ id: string; pattern: string; nextSeq: number }[]>`
    SELECT id, pattern, "nextSeq"
      FROM "DocumentSeries"
     WHERE "companyId" = ${args.companyId}
       AND "financialYearId" = ${args.financialYearId}
       AND "docType" = ${args.docType}::"DocType"
     FOR UPDATE
  `
  const series = rows[0]
  if (!series) {
    throw new NotFound(`No ${args.docType} series for FY ${args.fyLabel} — create it in Settings first`)
  }

  const seq = series.nextSeq
  const number = renderPattern(series.pattern, { FY: shortFy(args.fyLabel), SEQ: seq })

  /**
   * 🔴 docs/64 — checked HERE, at the moment the number comes into existence.
   *
   * `validateInvoiceNumber` has existed since docs/10 with tests and no caller. A series
   * configured with a longer prefix would have produced a number breaching rule 46(b) on
   * every invoice for the year, and nothing anywhere would have said so — the validator sat
   * beside the allocator the whole time.
   *
   * It fails the allocation rather than warning, because the alternative is a document
   * issued to a client with a defective number on it, which cannot be taken back.
   */
  const verdict = validateInvoiceNumber(number)
  if (!verdict.ok) {
    throw new AppError(
      `The ${args.docType} series for FY ${args.fyLabel} would produce "${number}". ${verdict.reason}. ` +
      'Rule 46(b) limits the number to sixteen characters, and allows only letters, digits, / and - — ' +
      'shorten the pattern in the series before issuing anything else.',
    )
  }

  await tx.documentSeries.update({ where: { companyId: args.companyId, id: series.id }, data: { nextSeq: seq + 1 } })
  return { number, seq }
}

/** `ADP/{FY}/{SEQ:4}` + { FY: '26-27', SEQ: 26 } -> `ADP/26-27/0026` */
export function renderPattern(pattern: string, vars: { FY: string; SEQ: number }): string {
  return pattern
    .replace('{FY}', vars.FY)
    .replace(/\{SEQ(?::(\d+))?\}/, (_m, pad?: string) =>
      pad ? String(vars.SEQ).padStart(Number(pad), '0') : String(vars.SEQ),
    )
}

/**
 * Is this pattern one a series may be set to? — docs/83 §6.
 *
 * 🔴 `DocumentSeries.pattern` was stored, rendered, validated against rule 46 and printed on
 * the settings page, and **nothing in the application could set it**. docs/67 §2's class
 * again: a field nothing binds. The shape of every number this company issues was decided by
 * the seed script and could be changed only in the database.
 *
 * It is the business's own numbering. `ADP/26-27/0028` and `28/ADP/26-27` are both perfectly
 * good rule 46 numbers and the choice between them belongs to whoever signs the invoice.
 *
 * Two placeholders are REQUIRED rather than merely offered:
 *
 * - **{SEQ}** — without it every document in the year renders the same string, and the second
 *   one fails on `@@unique([companyId, number])` at the end of a transaction that has already
 *   posted a ledger entry.
 * - **{FY}** — the uniqueness index is per COMPANY, not per financial year, so a pattern
 *   without the year collides with last year's run the moment the sequence restarts. The
 *   series row is per financial year; the number has to say which one.
 *
 * What is left over is literal text, and it is held to rule 46's own alphabet so the breach
 * is refused here rather than discovered at the next allocation.
 */
export function validatePattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  const p = pattern.trim()
  if (!p) return { ok: false, reason: 'A pattern is required' }
  if (!/\{SEQ(?::\d+)?\}/.test(p)) {
    return { ok: false, reason: 'The pattern must contain {SEQ} — without the sequence every document in the year would take the same number' }
  }
  if (!p.includes('{FY}')) {
    return { ok: false, reason: 'The pattern must contain {FY} — numbers are unique per company, not per year, so without it next year\u2019s run collides with this one' }
  }
  // 🔴 this one first: an unknown placeholder would otherwise be caught by the alphabet
  // check below, which would blame the braces and not say that {PREFIX} is not a thing
  if (/\{(?!SEQ(?::\d+)?\}|FY\})/.test(p)) {
    return { ok: false, reason: 'The only placeholders are {FY}, {SEQ} and {SEQ:n} for a zero-padded sequence' }
  }
  const literal = p.replace(/\{SEQ(?::\d+)?\}/, '').replace('{FY}', '')
  if (!/^[A-Za-z0-9/-]*$/.test(literal)) {
    return { ok: false, reason: 'Rule 46(b) allows only letters, digits, / and - around the placeholders' }
  }
  return { ok: true }
}

/**
 * Rule 46: an invoice number is at most 16 characters, and may contain only
 * alphanumerics, '/' and '-'. `ADP/26-27/0026` is 14.
 */
export function validateInvoiceNumber(number: string): { ok: true } | { ok: false; reason: string } {
  if (number.length > 16) return { ok: false, reason: `"${number}" is ${number.length} characters — Rule 46 allows 16` }
  if (!/^[A-Za-z0-9/-]+$/.test(number)) return { ok: false, reason: `"${number}" contains characters other than letters, digits, / and -` }
  return { ok: true }
}

/** Preview the next number without consuming it — for the UI and empty states. */
export async function peekNextNumber(
  tx: Tx,
  args: { companyId: string; financialYearId: string; docType: DocType; fyLabel: string },
): Promise<string | null> {
  const series = await tx.documentSeries.findFirst({
    where: { companyId: args.companyId, financialYearId: args.financialYearId, docType: args.docType },
  })
  return series ? renderPattern(series.pattern, { FY: shortFy(args.fyLabel), SEQ: series.nextSeq }) : null
}
