import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { shortFy } from '@/lib/fy'
import { renderPattern, validateInvoiceNumber, validatePattern } from './numbering'
import { currentFinancialYear } from '@/server/services/accounting/period'
import type { DocType } from '@prisma/client'

/**
 * The document series, and the holes in them — docs/64.
 *
 * 🔴 Rule 46(b) requires a tax invoice number to be **consecutive**, unique for the financial
 * year, and at most sixteen characters. Rule 53(1A)(c) says the same of a credit or debit
 * note and rule 49 of a receipt voucher. "Consecutive" is the word that matters: at an
 * assessment the question is not whether the numbers are unique, it is what happened to the
 * one that is missing.
 *
 * This system has had an unbroken allocator since docs/10 — a sequence taken inside the
 * document's own transaction, under `SELECT … FOR UPDATE`. What it has never had is any way
 * to SHOW that, which is the only form in which it is any use to somebody being asked.
 */

/**
 * 🔴 There is deliberately no `CANCELLED` reason.
 *
 * The first version had one, and the code to build it turned out to be unreachable: a
 * cancelled invoice KEEPS its number (docs/41 — "gaps in a GST series must be explainable"),
 * so a cancellation never produces a gap at all. Cancellations are listed in their own right
 * because an assessment asks about them; they are simply not holes.
 */
export type GapReason = 'BEFORE_THIS_SYSTEM' | 'UNEXPLAINED'

export interface SeriesGap {
  seq: number
  number: string
  reason: GapReason
  detail: string
}

export interface SeriesRow {
  docType: DocType
  pattern: string
  nextNumber: string
  /** the sequence the next number will take — the pattern form previews against it */
  nextSeq: number
  issued: number
  firstSeq: number | null
  lastSeq: number | null
  /** the sequence the series started at, where it did not start at 1 */
  openedAt: number
  cancelled: { number: string; reason: string | null }[]
  gaps: SeriesGap[]
  /** rule 46(b) / 53(1A)(c) / 49 — sixteen characters, alphanumerics, slash and dash */
  patternProblem: string | null
}

export interface SeriesRegister {
  fyLabel: string
  /** `26-27` — what {FY} renders to, so the pattern form previews the real string */
  fyShort: string
  rows: SeriesRow[]
  unexplained: number
}

/**
 * 🔴 docs/83 §6 — `?? d` is a fallback, not a label.
 *
 * `REFUND_VOUCHER` was missing, so that series was headed `REFUND_VOUCHER` on the settings
 * page — visible from the moment docs/65 added it, and never looked at. The map is
 * `Partial`, which is what let it be silently incomplete; it is total now, so the next
 * DocType added will not compile until it has a name a person can read.
 */
const LABEL: Record<DocType, string> = {
  TAX_INVOICE: 'Tax invoices', EXPORT_INVOICE: 'Export invoices',
  BILL_OF_SUPPLY: 'Bills of supply',
  CREDIT_NOTE: 'Credit notes', DEBIT_NOTE: 'Debit notes',
  RECEIPT: 'Receipt vouchers', REFUND_VOUCHER: 'Refund vouchers',
  SELF_INVOICE: 'Self-invoices (reverse charge)',
  PROFORMA: 'Proformas', QUOTATION: 'Quotations', PAYMENT_ADVICE: 'Payment advices',
}

export const seriesLabel = (d: DocType) => LABEL[d]

/**
 * 🔴 The sequence read back out of the number.
 *
 * Only `Invoice` stores the `seq` it was allocated; a credit note, a self-invoice and a
 * receipt voucher keep the rendered string alone. Rather than add a column to four tables
 * and leave every existing row null, the number is read against its own pattern — the
 * pattern is what produced it, so it is the one thing guaranteed to fit.
 */
export function seqFromNumber(pattern: string, fyLabel: string, number: string): number | null {
  const fy = shortFy(fyLabel)
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{FY\\}', fy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .replace(/\\\{SEQ(?::(\d+))?\\\}/, '(\\d+)')
  const m = new RegExp(`^${escaped}$`).exec(number)
  return m ? Number(m[1]) : null
}

export async function documentSeriesRegister(ctx: RequestContext, fyId?: string): Promise<SeriesRegister> {
  assertCan(ctx.role, 'invoices', 'read')

  // 🔴 `currentFinancialYear`, not "the newest open year" — docs/49 §4. Next year's row
  // exists before April because the numbering needs it, so the raw lookup jumps a year
  // ahead and reports an empty series. The guard in `reachable.integration.test.ts` caught
  // this one being written.
  const fy = fyId
    ? await prisma.financialYear.findFirstOrThrow({ where: { id: fyId, companyId: ctx.companyId } })
    : await currentFinancialYear(ctx.companyId)
  if (!fy) return { fyLabel: '—', fyShort: '—', rows: [], unexplained: 0 }

  const [series, invoices, notes, bills, receipts] = await Promise.all([
    prisma.documentSeries.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id }, orderBy: { docType: 'asc' },
    }),
    prisma.invoice.findMany({
      // 🔴 a DRAFT carries a placeholder number and `seq: 0` — it has taken nothing from the
      // series. Counting those as issued would put a document at sequence zero and make every
      // real number look like a gap above it.
      where: { companyId: ctx.companyId, financialYearId: fy.id, seq: { gt: 0 } },
      select: { number: true, seq: true, docType: true, status: true, cancelReason: true },
    }),
    prisma.creditNote.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id },
      select: { number: true, noteType: true, cancelledAt: true, cancelReason: true },
    }),
    prisma.vendorBill.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id, selfInvoiceNo: { not: null } },
      select: { selfInvoiceNo: true, status: true },
    }),
    prisma.receipt.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id },
      select: { number: true, cancelledAt: true, cancelReason: true },
    }),
  ])

  const rows: SeriesRow[] = []

  for (const s of series) {
    const docs: { number: string; seq: number | null; cancelled: boolean; reason: string | null }[] = []

    const add = (number: string | null, seq: number | null, cancelled: boolean, reason: string | null) => {
      if (!number) return
      docs.push({ number, seq: seq ?? seqFromNumber(s.pattern, fy.label, number), cancelled, reason })
    }

    if (s.docType === 'TAX_INVOICE' || s.docType === 'EXPORT_INVOICE') {
      for (const i of invoices.filter((x) => x.docType === s.docType)) {
        add(i.number, i.seq, i.status === 'CANCELLED', i.cancelReason)
      }
    }
    if (s.docType === 'CREDIT_NOTE' || s.docType === 'DEBIT_NOTE') {
      const want = s.docType === 'CREDIT_NOTE' ? 'CREDIT' : 'DEBIT'
      for (const n of notes.filter((x) => x.noteType === want)) {
        add(n.number, null, n.cancelledAt !== null, n.cancelReason)
      }
    }
    if (s.docType === 'SELF_INVOICE') {
      for (const b of bills) add(b.selfInvoiceNo, null, b.status === 'CANCELLED', null)
    }
    if (s.docType === 'RECEIPT') {
      for (const r of receipts) add(r.number, null, r.cancelledAt !== null, r.cancelReason)
    }

    const seqs = docs.map((d) => d.seq).filter((n): n is number => n !== null).sort((a, b) => a - b)
    const firstSeq = seqs[0] ?? null
    const lastSeq = seqs[seqs.length - 1] ?? null

    /**
     * 🔴 Where the series OPENED, which is not necessarily 1.
     *
     * Adpedia's invoice series was seeded at 26 because twenty-five invoices were issued by
     * hand before this system existed (docs/03). Reporting those as twenty-five missing
     * invoices would bury any real gap under a permanent false alarm — and it is precisely
     * the kind of alarm people learn to scroll past.
     */
    const openedAt = Math.min(firstSeq ?? s.nextSeq, s.nextSeq)

    const present = new Set(seqs)

    const gaps: SeriesGap[] = []
    for (let n = openedAt; n < s.nextSeq; n++) {
      if (present.has(n)) continue
      gaps.push({
        seq: n,
        number: renderPattern(s.pattern, { FY: shortFy(fy.label), SEQ: n }),
        reason: 'UNEXPLAINED',
        detail:
          'This number was taken from the series and no document carries it. A consecutive series ' +
          'with a hole in it is the first thing an assessment asks about — find out what was issued ' +
          'under it, or be able to say why nothing was.',
      })
    }
    if (openedAt > 1) {
      gaps.unshift({
        seq: openedAt - 1,
        number: `1–${openedAt - 1}`,
        reason: 'BEFORE_THIS_SYSTEM',
        detail: `The series opened at ${openedAt}. Numbers below that were issued before this system held the series, and are not missing from it.`,
      })
    }

    // 🔴 the validator that had no caller — docs/64. A pattern is checked at its widest:
    // the highest sequence it will render this year, not the one it renders today.
    const widest = renderPattern(s.pattern, { FY: shortFy(fy.label), SEQ: 9999 })
    const verdict = validateInvoiceNumber(widest)

    rows.push({
      docType: s.docType,
      pattern: s.pattern,
      nextNumber: renderPattern(s.pattern, { FY: shortFy(fy.label), SEQ: s.nextSeq }),
      nextSeq: s.nextSeq,
      issued: docs.length,
      firstSeq, lastSeq, openedAt,
      cancelled: docs.filter((d) => d.cancelled).map((d) => ({ number: d.number, reason: d.reason })),
      gaps,
      patternProblem: verdict.ok ? null : verdict.reason,
    })
  }

  return {
    fyLabel: fy.label,
    fyShort: shortFy(fy.label),
    rows,
    unexplained: rows.reduce((a, r) => a + r.gaps.filter((g) => g.reason === 'UNEXPLAINED').length, 0),
  }
}

/**
 * Change the shape of the numbers a series issues — docs/83 §6.
 *
 * 🔴 The sequence is NOT touched. Rule 46(b) wants the run consecutive, and the run is the
 * sequence, not the string it is printed into: 26, 27, 28 stays 26, 27, 28 whether it reads
 * `ADP/26-27/0028` or `28/ADP/26-27`. Moving `nextSeq` is a different act with different
 * consequences — it either repeats a number already issued or leaves a hole the register will
 * report as unexplained — and it is not what changing a format means.
 *
 * 🔴 The new pattern is checked at its WIDEST, not at the next number, exactly as docs/64's
 * register does: a pattern that is fine at 28 and breaches sixteen characters at 9999 would
 * otherwise be accepted now and block issuing later in the year, which is the worse moment.
 *
 * Changing it mid-year is allowed, and audited. Documents already issued keep the number they
 * were issued with — they are what the client holds, and rewriting them is the one thing the
 * whole of docs/59 exists to prevent.
 */
export async function setSeriesPattern(
  ctx: RequestContext,
  args: { docType: DocType; pattern: string },
): Promise<{ docType: DocType; pattern: string; nextNumber: string; issued: number }> {
  assertCan(ctx.role, 'settings.company', 'write')

  const pattern = args.pattern.trim()
  const shape = validatePattern(pattern)
  if (!shape.ok) throw new AppError(shape.reason)

  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) throw new NotFound('There is no open financial year to set a series for')

  const series = await prisma.documentSeries.findFirst({
    where: { companyId: ctx.companyId, financialYearId: fy.id, docType: args.docType },
  })
  if (!series) throw new NotFound(`No ${args.docType} series for FY ${fy.label}`)

  const widest = renderPattern(pattern, { FY: shortFy(fy.label), SEQ: 9999 })
  const verdict = validateInvoiceNumber(widest)
  if (!verdict.ok) {
    throw new AppError(
      `That pattern reaches "${widest}" later this year. ${verdict.reason}. ` +
      'Rule 46(b) limits the number to sixteen characters, and allows only letters, digits, / and -.',
    )
  }

  await prisma.documentSeries.update({ where: { companyId: ctx.companyId, id: series.id }, data: { pattern } })
  await audit(ctx, {
    entity: 'DocumentSeries', entityId: series.id, action: 'UPDATE',
    before: { pattern: series.pattern }, after: { pattern },
  })

  const issued = await prisma.invoice.count({
    where: { companyId: ctx.companyId, financialYearId: fy.id, number: { not: '' } },
  })
  return {
    docType: args.docType,
    pattern,
    nextNumber: renderPattern(pattern, { FY: shortFy(fy.label), SEQ: series.nextSeq }),
    issued,
  }
}
