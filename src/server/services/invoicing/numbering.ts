import type { Tx } from '@/server/db'
import type { DocType } from '@prisma/client'
import { NotFound } from '@/server/errors'
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

  await tx.documentSeries.update({ where: { id: series.id }, data: { nextSeq: seq + 1 } })
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
