import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { assertGstRegistered } from './gst-registration'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { randomUUID } from 'node:crypto'

/**
 * GSTR-2B against the purchase register — docs/62.
 *
 * docs/56 compared the two credit ledgers and could say that ₹x of claimed credit was not on
 * the portal. It could not say **whose** — and that is the only form of the answer anybody
 * can act on, because the remedy is to telephone a supplier.
 *
 * 🔴 s.16(2)(aa) is the whole reason this matters. Input credit is not available at all
 * unless the supplier has furnished the invoice in their GSTR-1 and it appears in the
 * recipient's GSTR-2B. A bill in our books that is missing from 2B is not a timing
 * difference and not a bookkeeping error: it is credit we may not take, and if a GSTR-3B has
 * already claimed it, it must be reversed with interest at 18% under s.50(3) read with
 * rule 88B(3).
 */

/**
 * 🔴 The number as the two sides will never quite agree on it.
 *
 * A supplier files `EX/300`; the person entering the bill types `EX-300`, or `ex 300`, or
 * `EX 300 ` with a trailing space off a PDF. Matching on the literal string finds almost
 * nothing and reports a company's entire purchase register as unavailable credit — which is
 * both terrifying and useless. Case and punctuation go; the digits and letters stay.
 */
export function docKey(n: string): string {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface Parsed2bRow {
  supplierGstin: string
  supplierName: string | null
  docNumber: string
  docDate: Date | null
  docType: string | null
  taxableValue: Decimal
  igst: Decimal
  cgst: Decimal
  sgst: Decimal
  cess: Decimal
  itcAvailable: boolean
  itcReason: string | null
  raw: string
}

export interface Parse2bResult {
  rows: Parsed2bRow[]
  skipped: { line: number; reason: string; raw: string }[]
}

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/

const d = (v: unknown): Decimal => {
  const n = Number(v)
  return Number.isFinite(n) ? new Decimal(n.toFixed(2)) : ZERO
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  // the portal's JSON uses dd-mm-yyyy; a spreadsheet may use anything
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v.trim())
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t)
}

/**
 * 🔴 The portal's own JSON is read directly, because that is what it hands you.
 *
 * GSTR-2B downloads as JSON. Re-keying it into a spreadsheet first is where transcription
 * errors enter a reconciliation whose entire purpose is to find discrepancies — and the
 * document already carries `itcavl`, the portal's own verdict on each invoice, which no
 * hand-made CSV will have.
 */
export function parse2b(text: string): Parse2bResult {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parse2bJson(trimmed)
  return parse2bDelimited(trimmed)
}

interface B2bItem { igst?: number; cgst?: number; sgst?: number; cess?: number; txval?: number }
interface B2bInv {
  inum?: string; idt?: string; typ?: string; val?: number
  itcavl?: string; rsn?: string; items?: B2bItem[]
}
interface B2bSupplier { ctin?: string; trdnm?: string; inv?: B2bInv[]; cn?: B2bInv[]; dn?: B2bInv[] }

function parse2bJson(text: string): Parse2bResult {
  const rows: Parsed2bRow[] = []
  const skipped: Parse2bResult['skipped'] = []

  let doc: unknown
  try { doc = JSON.parse(text) } catch (e) {
    throw new AppError(`That is not valid JSON — ${e instanceof Error ? e.message : 'could not be read'}`)
  }

  const root = doc as { data?: { docdata?: Record<string, B2bSupplier[]> }; docdata?: Record<string, B2bSupplier[]> }
  const docdata = root.data?.docdata ?? root.docdata
  if (!docdata) {
    throw new AppError('That JSON has no `docdata` section — download the GSTR-2B JSON from Returns → GSTR-2B → Download')
  }

  // b2b is the ordinary case; b2ba are amendments to it, which are equally part of the credit
  for (const section of ['b2b', 'b2ba'] as const) {
    for (const supplier of docdata[section] ?? []) {
      const gstin = (supplier.ctin ?? '').toUpperCase()
      for (const inv of supplier.inv ?? []) {
        if (!inv.inum) {
          skipped.push({ line: 0, reason: `${gstin || 'A supplier'} has an invoice with no number`, raw: JSON.stringify(inv).slice(0, 120) })
          continue
        }
        const items = inv.items ?? []
        rows.push({
          supplierGstin: gstin,
          supplierName: supplier.trdnm ?? null,
          docNumber: inv.inum,
          docDate: toDate(inv.idt),
          docType: inv.typ ?? (section === 'b2ba' ? 'AMENDMENT' : null),
          taxableValue: items.reduce((a, i) => a.plus(d(i.txval)), ZERO as Decimal),
          igst: items.reduce((a, i) => a.plus(d(i.igst)), ZERO as Decimal),
          cgst: items.reduce((a, i) => a.plus(d(i.cgst)), ZERO as Decimal),
          sgst: items.reduce((a, i) => a.plus(d(i.sgst)), ZERO as Decimal),
          cess: items.reduce((a, i) => a.plus(d(i.cess)), ZERO as Decimal),
          // 🔴 the portal says "N" when it is telling you not to claim — a place of supply
          // outside the state, a return filed after the s.16(4) deadline. Honoured, not ignored.
          itcAvailable: (inv.itcavl ?? 'Y').toUpperCase() !== 'N',
          itcReason: inv.rsn ?? null,
          raw: JSON.stringify(inv).slice(0, 400),
        })
      }
    }
  }

  return { rows, skipped }
}

function splitLine(line: string): string[] {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if ((c === ',' || c === '\t' || c === ';') && !q) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * The spreadsheet shape, read positionally against a GSTIN anchor.
 *
 * 🔴 The three taxes are taken from NAMED columns where a header row exists, and only fall
 * back to position when it does not. Guessing which of four money columns is CGST is how a
 * reconciliation quietly compares the wrong figures and declares everything matched.
 */
function parse2bDelimited(text: string): Parse2bResult {
  const rows: Parsed2bRow[] = []
  const skipped: Parse2bResult['skipped'] = []
  const lines = text.split(/\r?\n/)

  let cols: Record<string, number> | null = null
  for (const line of lines) {
    const cells = splitLine(line).map((c) => c.toLowerCase())
    if (cells.some((c) => /integrated|igst/.test(c)) && cells.some((c) => /central|cgst/.test(c))) {
      cols = {}
      cells.forEach((c, i) => {
        if (/gstin/.test(c)) cols!.gstin ??= i
        else if (/trade|supplier|name/.test(c)) cols!.name ??= i
        else if (/invoice no|document no|doc no|number/.test(c)) cols!.num ??= i
        else if (/date/.test(c)) cols!.date ??= i
        else if (/taxable/.test(c)) cols!.taxable ??= i
        else if (/integrated|igst/.test(c)) cols!.igst ??= i
        else if (/central|cgst/.test(c)) cols!.cgst ??= i
        else if (/state|sgst|utgst/.test(c)) cols!.sgst ??= i
        else if (/cess/.test(c)) cols!.cess ??= i
        else if (/itc avail|availability/.test(c)) cols!.itc ??= i
        else if (/reason/.test(c)) cols!.reason ??= i
      })
      break
    }
  }

  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    const cells = splitLine(t)
    const gstin = GSTIN_RE.exec(t.toUpperCase())?.[1]
    if (!gstin) {
      if (/\d{2,}/.test(t) && cells.length > 3) {
        skipped.push({ line: i + 1, reason: 'No supplier GSTIN on the line', raw: t.slice(0, 120) })
      }
      return
    }
    if (!cols) {
      skipped.push({
        line: i + 1,
        reason: 'No header row naming the tax columns — paste the portal JSON, or keep the header',
        raw: t.slice(0, 120),
      })
      return
    }

    const at = (k: string) => (cols![k] === undefined ? '' : cells[cols![k]] ?? '')
    const num = at('num')
    if (!num) {
      skipped.push({ line: i + 1, reason: 'No invoice number on the line', raw: t.slice(0, 120) })
      return
    }

    rows.push({
      supplierGstin: gstin,
      supplierName: at('name') || null,
      docNumber: num,
      docDate: toDate(at('date')),
      docType: null,
      taxableValue: d(at('taxable').replace(/[₹,\s]/g, '')),
      igst: d(at('igst').replace(/[₹,\s]/g, '')),
      cgst: d(at('cgst').replace(/[₹,\s]/g, '')),
      sgst: d(at('sgst').replace(/[₹,\s]/g, '')),
      cess: d(at('cess').replace(/[₹,\s]/g, '')),
      itcAvailable: !/^n/i.test(at('itc').trim()),
      itcReason: at('reason') || null,
      raw: t.slice(0, 400),
    })
  })

  return { rows, skipped }
}

// ───────────────────────────────────────────────────────────── importing ──

export async function import2b(
  ctx: RequestContext, input: { asOn: string; text: string; filename?: string },
) {
  assertCan(ctx.role, 'tax', 'write')
  await assertGstRegistered(ctx.companyId, 'a GSTR-2B')

  const asOn = new Date(input.asOn)
  if (Number.isNaN(asOn.getTime())) throw new AppError('Say which date this 2B is as at')

  const parsed = parse2b(input.text)
  if (parsed.rows.length === 0) {
    throw new AppError(
      `No invoices could be read from that${parsed.skipped.length ? `, and ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} could not be parsed` : ''}. ` +
      'Paste the GSTR-2B JSON from the portal, or a sheet with a header row naming the tax columns.',
    )
  }

  const importBatch = randomUUID()
  const statement = await prisma.$transaction(async (tx) => {
    const s = await tx.portalStatement.create({
      data: {
        companyId: ctx.companyId, kind: 'GST_2B', asOn,
        filename: input.filename ?? null, importBatch, importedById: ctx.userId,
      },
    })
    for (const r of parsed.rows) {
      await tx.gst2bLine.create({
        data: {
          statementId: s.id, companyId: ctx.companyId,
          supplierGstin: r.supplierGstin, supplierName: r.supplierName,
          docNumber: r.docNumber, docKey: docKey(r.docNumber), docDate: r.docDate, docType: r.docType,
          taxableValue: r.taxableValue.toFixed(2), igst: r.igst.toFixed(2),
          cgst: r.cgst.toFixed(2), sgst: r.sgst.toFixed(2), cess: r.cess.toFixed(2),
          itcAvailable: r.itcAvailable, itcReason: r.itcReason, raw: r.raw,
        },
      })
    }
    return s
  })

  await audit(ctx, {
    entity: 'PortalStatement', entityId: statement.id, action: 'CREATE',
    after: { kind: 'GST_2B', asOn: asOn.toISOString().slice(0, 10), rows: parsed.rows.length },
  })
  return { statement, rows: parsed.rows.length, skipped: parsed.skipped }
}

// ─────────────────────────────────────────────────────────── reconciling ──

export interface MatchedRow {
  billId: string
  billNumber: string
  vendorName: string
  ourTax: Decimal
  portalTax: Decimal
  difference: Decimal
  tier: string
  /** the portal says this credit is not available, whatever our books claim */
  blockedByPortal: string | null
}

export interface Recon2b {
  asOn: Date | null
  statementId: string | null
  matched: MatchedRow[]
  taxDiffers: MatchedRow[]
  blocked: MatchedRow[]
  /** in our books, nowhere in 2B — the ones that cost money */
  notInPortal: { billId: string; billNumber: string; vendorName: string; gstin: string | null; billDate: Date; tax: Decimal; action: string }[]
  /** on the portal, not in our books — credit we have not taken, and a cost we have not booked */
  notInBooks: { id: string; supplier: string; gstin: string; docNumber: string; docDate: Date | null; tax: Decimal; action: string }[]
  totals: { creditAtRisk: Decimal; creditUnclaimed: Decimal; matchedTax: Decimal }
  verdict: string
}

const RUPEE = new Decimal('1')

/**
 * The comparison, without writing anything — docs/62.
 *
 * 🔴 Split out because the chase screen needs it too, and a page that writes to the database
 * to render itself is the thing that turns a refresh into a side effect. The matching rules
 * live here once: a second copy in the chase service would be the docs/49 mistake, where two
 * implementations of one rule drift until one of them is wrong.
 */
export async function compare2b(ctx: RequestContext, statementId?: string): Promise<Recon2b & { pairs: { billId: string; lineId: string }[] }> {
  assertCan(ctx.role, 'tax', 'read')

  const statement = statementId
    ? await prisma.portalStatement.findFirstOrThrow({ where: { id: statementId, companyId: ctx.companyId, kind: 'GST_2B' } })
    : await prisma.portalStatement.findFirst({
        where: { companyId: ctx.companyId, kind: 'GST_2B' },
        orderBy: [{ asOn: 'desc' }, { importedAt: 'desc' }],
      })

  const empty: Recon2b = {
    asOn: null, statementId: null, matched: [], taxDiffers: [], blocked: [],
    notInPortal: [], notInBooks: [],
    totals: { creditAtRisk: ZERO, creditUnclaimed: ZERO, matchedTax: ZERO },
    verdict: 'No GSTR-2B imported',
  }
  if (!statement) return { ...empty, pairs: [] }

  const [lines, bills] = await Promise.all([
    prisma.gst2bLine.findMany({ where: { statementId: statement.id } }),
    prisma.vendorBill.findMany({
      where: {
        companyId: ctx.companyId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        // 🔴 only bills that CLAIM credit. A blocked one (s.17(5)) is not in 2B's job, and
        // reporting it as missing would bury the ones that matter.
        itcEligible: true,
      },
      include: { vendor: { select: { name: true, gstin: true } } },
      orderBy: { billDate: 'asc' },
    }),
  ])

  const taxOf = (b: { cgst: unknown; sgst: unknown; igst: unknown }) =>
    new Decimal(String(b.cgst)).plus(String(b.sgst)).plus(String(b.igst))
  const lineTax = (l: (typeof lines)[number]) =>
    new Decimal(l.igst.toString()).plus(l.cgst.toString()).plus(l.sgst.toString())

  const usedLines = new Set<string>()
  const usedBills = new Set<string>()
  // 🔴 the pairing is remembered as it is made. Re-deriving it afterwards to write the
  // match back repeated only the FIRST tier's rule, so everything found by the looser two
  // was matched in the report and left unmatched in the database.
  const pairs: { billId: string; lineId: string }[] = []
  const matched: MatchedRow[] = []
  const taxDiffers: MatchedRow[] = []
  const blocked: MatchedRow[] = []

  type Bill = (typeof bills)[number]
  type Line = (typeof lines)[number]

  /**
   * 🔴 GSTIN and the normalised number first; amount is only a fallback.
   *
   * Two invoices from the same supplier in the same month for the same amount are ordinary —
   * a monthly retainer is exactly that — so matching on amount first pairs them arbitrarily
   * and then reports both as fine while they are crossed over.
   */
  const tiers: { name: string; fits: (b: Bill, l: Line) => boolean }[] = [
    {
      name: 'GSTIN and invoice number',
      fits: (b, l) => b.vendor.gstin?.toUpperCase() === l.supplierGstin && docKey(b.billNumber) === l.docKey,
    },
    {
      name: 'invoice number and tax',
      fits: (b, l) => docKey(b.billNumber) === l.docKey && taxOf(b).minus(lineTax(l)).abs().lte(RUPEE),
    },
    {
      name: 'GSTIN, date and tax',
      fits: (b, l) => b.vendor.gstin?.toUpperCase() === l.supplierGstin
        && l.docDate !== null
        && b.billDate.toISOString().slice(0, 10) === l.docDate.toISOString().slice(0, 10)
        && taxOf(b).minus(lineTax(l)).abs().lte(RUPEE),
    },
  ]

  for (const tier of tiers) {
    for (const b of bills) {
      if (usedBills.has(b.id)) continue
      const l = lines.find((x) => !usedLines.has(x.id) && tier.fits(b, x))
      if (!l) continue
      usedBills.add(b.id); usedLines.add(l.id)
      pairs.push({ billId: b.id, lineId: l.id })

      const ourTax = taxOf(b), portalTax = lineTax(l)
      const row: MatchedRow = {
        billId: b.id, billNumber: b.billNumber, vendorName: b.vendor.name,
        ourTax, portalTax, difference: ourTax.minus(portalTax), tier: tier.name,
        blockedByPortal: l.itcAvailable ? null : (l.itcReason ?? 'The portal reports this credit as not available'),
      }
      if (!l.itcAvailable) blocked.push(row)
      else if (row.difference.abs().gt(RUPEE)) taxDiffers.push(row)
      else matched.push(row)
    }
  }

  const notInPortal = bills.filter((b) => !usedBills.has(b.id)).map((b) => {
    const tax = taxOf(b)
    return {
      billId: b.id, billNumber: b.billNumber, vendorName: b.vendor.name,
      gstin: b.vendor.gstin, billDate: b.billDate, tax,
      action: b.vendor.gstin
        ? `${b.vendor.name} has not reported this invoice. Under s.16(2)(aa) the ${formatINR(tax)} of credit is not available until they do — ` +
          'if a GSTR-3B has already claimed it, it has to be reversed with interest at 18%. Ask them to include it in their next GSTR-1.'
        : `${b.vendor.name} has no GSTIN on record, so nothing can be matched and no credit should have been claimed. Check the bill.`,
    }
  })

  const notInBooks = lines.filter((l) => !usedLines.has(l.id)).map((l) => ({
    id: l.id, supplier: l.supplierName ?? l.supplierGstin, gstin: l.supplierGstin,
    docNumber: l.docNumber, docDate: l.docDate, tax: lineTax(l),
    action: `${l.supplierName ?? l.supplierGstin} reported invoice ${l.docNumber} and it is not in the books. ` +
      `That is ${formatINR(lineTax(l))} of credit nobody has claimed — and an expense missing from the P&L with it.`,
  }))

  const total = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), ZERO as Decimal)

  /**
   * 🔴 Only the EXCESS counts as at risk where the two differ.
   *
   * Claiming ₹9,000 against a 2B that shows ₹8,500 puts ₹500 at risk, not ₹9,000 — and the
   * other way round nothing is at risk at all, only unclaimed. Summing the whole invoice
   * would produce a frightening number that no action follows from.
   */
  const creditAtRisk = total([
    ...notInPortal.map((r) => r.tax),
    ...blocked.map((r) => r.ourTax),
    ...taxDiffers.map((r) => Decimal.max(r.difference, ZERO)),
  ])

  const problems = notInPortal.length + notInBooks.length + taxDiffers.length + blocked.length

  return {
    pairs,
    asOn: statement.asOn, statementId: statement.id,
    matched, taxDiffers, blocked, notInPortal, notInBooks,
    totals: {
      creditAtRisk,
      creditUnclaimed: total(notInBooks.map((r) => r.tax)),
      matchedTax: total(matched.map((m) => m.ourTax)),
    },
    verdict: problems === 0
      ? `All ${matched.length} invoice${matched.length === 1 ? '' : 's'} agree with GSTR-2B`
      : `${matched.length} agree · ${problems} to look at · ${formatINR(creditAtRisk)} of credit at risk`,
  }
}


/**
 * The comparison, and writing back what it concluded.
 *
 * The match is recorded against the 2B row so a later reading can show which bill answered
 * it, and the statement keeps its verdict the way every other portal statement does.
 */
export async function reconcile2b(ctx: RequestContext, statementId?: string): Promise<Recon2b> {
  assertCan(ctx.role, 'tax', 'write')
  const { pairs, ...result } = await compare2b(ctx, statementId)
  if (!result.statementId) return result

  await prisma.$transaction(async (tx) => {
    for (const p of pairs) {
      await tx.gst2bLine.update({ where: { id: p.lineId }, data: { matchedBillId: p.billId } })
    }
    await tx.portalStatement.update({
      where: { companyId: ctx.companyId, id: result.statementId! },
      data: {
        verdict: `${result.matched.length} matched, ` +
          `${result.notInPortal.length + result.notInBooks.length + result.taxDiffers.length + result.blocked.length} to look at`,
      },
    })
  })
  return result
}
