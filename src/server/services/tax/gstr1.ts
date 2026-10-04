import { prisma } from '@/server/db'
import { refundsInPeriod } from '@/server/services/sales/refund'
import { noteAmendmentsForPeriod } from './gst-note-amendment'
import { Decimal, ZERO } from '@/lib/money'
import { amendmentsForPeriod } from './gst-amendment'
import { advanceTaxPosted } from '@/server/services/sales/advance'

/**
 * GSTR-1 — outward supplies.
 *
 * 🔴 This builds an EXPORT FOR THE CA, not a portal filing. The GSTN schema changes
 * and the offline utility is versioned; hard-coding it means silent breakage at the
 * worst possible moment. Same reasoning as the TDS return export in docs/02 §B2.
 *
 * Sections built: B2B, B2CS (consolidated), EXP, CDNR (credit notes), HSN, DOCS.
 */

export interface B2BRow {
  gstin: string
  customerName: string
  invoiceNumber: string
  invoiceDate: Date
  invoiceValue: Decimal
  placeOfSupply: string
  reverseCharge: 'N' | 'Y'
  rate: number
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
}

export interface ExportRow {
  invoiceNumber: string
  invoiceDate: Date
  invoiceValue: Decimal
  /** WPAY = with payment of IGST, WOPAY = under LUT without payment */
  exportType: 'WPAY' | 'WOPAY'
  taxableValue: Decimal
  igst: Decimal
  currency: string
  customerName: string
  lutArn: string | null
}

export interface HsnRow {
  sac: string
  description: string
  uqc: string
  quantity: Decimal
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
}

export interface Gstr1 {
  period: { label: string; from: Date; to: Date }
  gstin: string
  b2b: B2BRow[]
  b2cs: { placeOfSupply: string; rate: number; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]
  exports: ExportRow[]
  /** cdnr — credit AND debit notes, flagged. docs/53. */
  creditNotes: { noteType: 'CREDIT' | 'DEBIT'; number: string; date: Date; againstInvoice: string | null; reason: string; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]
  /**
   * Table 9A — amendments to invoices filed in an earlier period (docs/52).
   *
   * 🔴 The original row stays in the return that carried it. 9A reports the REVISED
   * particulars against the original number and date, which is how the portal supersedes one
   * with the other.
   */
  amendedInvoices: {
    originalNumber: string; originalDate: Date; originalPeriod: string
    gstin: string | null; placeOfSupply: string; reason: string
    taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; invoiceValue: Decimal
  }[]
  /**
   * 11A — advances received on which tax is payable, and 11B — advances adjusted against
   * invoices raised in this period. docs/54.
   *
   * 🔴 The pair is what stops the same supply being taxed twice: 11A declares the tax when
   * the money arrives, 11B takes it back when the invoice declares its own.
   */
  /**
   * docs/66 — table 9C: amendments to credit and debit notes already filed. The mirror of
   * 9A, and reported separately because the portal keeps them in separate tables.
   */
  amendedNotes: { number: string; noteDate: Date; noteType: string; againstInvoice: string | null; originalPeriod: string; gstin: string | null; placeOfSupply: string | null; original: { taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }; revised: { taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal } }[]
  advancesReceived: { number: string; date: Date; customerName: string; placeOfSupply: string; rate: number; grossAdvance: Decimal; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]
  advancesAdjusted: { number: string; date: Date; customerName: string; againstInvoice: string; amount: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]
  /**
   * docs/65 — advances RETURNED, where no supply was made. They belong in 11B with the
   * adjustments, because both do the same thing to the same liability: take back tax
   * declared in 11A of an earlier period.
   */
  advancesRefunded: { number: string; date: Date; customerName: string; againstReceipt: string; amount: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]
  hsn: HsnRow[]
  docs: { type: string; from: string; to: string; total: number; cancelled: number }[]
  totals: { taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; invoiceValue: Decimal }
  warnings: string[]
}

function rateOf(line: { gstRatePct: unknown }) { return Number(line.gstRatePct) }

export async function buildGstr1(companyId: string, from: Date, to: Date, label: string): Promise<Gstr1> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })

  const invoices = await prisma.invoice.findMany({
    where: { companyId, date: { gte: from, lte: to }, status: { not: 'DRAFT' } },
    include: { customer: true, lines: true, lut: true },
    orderBy: [{ date: 'asc' }, { seq: 'asc' }],
  })

  const live = invoices.filter((i) => i.status !== 'CANCELLED')
  const warnings: string[] = []

  // ── B2B: registered recipients, one row per invoice per rate ────────────────
  const b2b: B2BRow[] = []
  for (const inv of live.filter((i) => i.customer.gstin && i.taxMode !== 'EXPORT')) {
    const byRate = new Map<number, { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>()
    for (const l of inv.lines) {
      const r = rateOf(l)
      const acc = byRate.get(r) ?? { taxable: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO }
      byRate.set(r, {
        taxable: acc.taxable.plus(l.taxableValue.toString()),
        cgst: acc.cgst.plus(l.cgst.toString()),
        sgst: acc.sgst.plus(l.sgst.toString()),
        igst: acc.igst.plus(l.igst.toString()),
      })
    }
    for (const [rate, v] of byRate) {
      b2b.push({
        gstin: inv.customer.gstin!,
        customerName: inv.customer.name,
        invoiceNumber: inv.number,
        invoiceDate: inv.date,
        invoiceValue: new Decimal(inv.grandTotal.toString()),
        placeOfSupply: inv.placeOfSupply,
        reverseCharge: 'N',
        rate,
        taxableValue: v.taxable, cgst: v.cgst, sgst: v.sgst, igst: v.igst,
      })
    }
  }

  // ── B2CS: unregistered recipients, consolidated by place of supply and rate ──
  const b2csMap = new Map<string, { placeOfSupply: string; rate: number; taxableValue: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>()
  for (const inv of live.filter((i) => !i.customer.gstin && i.taxMode !== 'EXPORT')) {
    for (const l of inv.lines) {
      const rate = rateOf(l)
      const key = `${inv.placeOfSupply}|${rate}`
      const acc = b2csMap.get(key) ?? { placeOfSupply: inv.placeOfSupply, rate, taxableValue: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO }
      b2csMap.set(key, {
        ...acc,
        taxableValue: acc.taxableValue.plus(l.taxableValue.toString()),
        cgst: acc.cgst.plus(l.cgst.toString()),
        sgst: acc.sgst.plus(l.sgst.toString()),
        igst: acc.igst.plus(l.igst.toString()),
      })
    }
    // a B2C inter-state supply above ₹2.5L belongs in B2CL, not B2CS
    if (inv.taxMode === 'INTER' && new Decimal(inv.grandTotal.toString()).gt(250000)) {
      warnings.push(`${inv.number}: inter-state B2C over ₹2,50,000 — belongs in table B2CL, which this export does not yet build.`)
    }
  }

  // ── Exports ─────────────────────────────────────────────────────────────────
  const exports: ExportRow[] = live
    .filter((i) => i.taxMode === 'EXPORT' || i.taxMode === 'SEZ_WITHOUT_PAY')
    .map((inv) => {
      if (!inv.lut) warnings.push(`${inv.number}: zero-rated with no LUT linked — it must be reported WPAY with IGST, or the LUT must be filed.`)
      return {
        invoiceNumber: inv.number,
        invoiceDate: inv.date,
        invoiceValue: new Decimal(inv.grandTotal.toString()),
        exportType: inv.lut ? 'WOPAY' as const : 'WPAY' as const,
        taxableValue: new Decimal(inv.taxableValue.toString()),
        igst: new Decimal(inv.igst.toString()),
        currency: inv.currency,
        customerName: inv.customer.name,
        lutArn: inv.lut?.arn ?? null,
      }
    })

  // ── Credit notes ────────────────────────────────────────────────────────────
  //
  // 🔴 Only the ones that actually adjust tax — docs/48. A note raised after the s.34(2)
  // deadline is a commercial credit between the parties: it recovers no GST, so reporting it
  // here would claim a reduction the return cannot support.
  const cns = await prisma.creditNote.findMany({
    where: { companyId, date: { gte: from, lte: to }, gstAdjusted: true, cancelledAt: null },
    include: { invoice: { select: { number: true } } },
    orderBy: { date: 'asc' },
  })
  // 🔴 only credit notes can be commercial — s.34(2) restricts them alone (docs/53)
  const commercial = await prisma.creditNote.count({
    where: { companyId, date: { gte: from, lte: to }, gstAdjusted: false, cancelledAt: null, noteType: 'CREDIT' },
  })
  const creditNotes = cns.map((c) => ({
    noteType: c.noteType,
    number: c.number, date: c.date, againstInvoice: c.invoice?.number ?? null, reason: c.reason,
    taxableValue: new Decimal(c.taxableValue.toString()),
    cgst: new Decimal(c.cgst.toString()), sgst: new Decimal(c.sgst.toString()), igst: new Decimal(c.igst.toString()),
  }))

  // ── Tables 11A and 11B: advances ────────────────────────────────────────────
  const advanceRows = await prisma.receipt.findMany({
    where: { companyId, isAdvance: true, cancelledAt: null, date: { gte: from, lte: to } },
    include: { customer: { select: { name: true, stateCode: true } } },
    orderBy: { date: 'asc' },
  })

  const advancesReceived = []
  for (const a of advanceRows) {
    const tax = await advanceTaxPosted(companyId, a.id)
    const gross = new Decimal(a.amount.toString()).plus(a.tdsAmount.toString())
    const total = tax.cgst.plus(tax.sgst).plus(tax.igst)
    const taxable = gross.minus(total)
    advancesReceived.push({
      number: a.number, date: a.date, customerName: a.customer.name,
      placeOfSupply: a.customer.stateCode ?? '—',
      // the rate it was actually charged at, derived rather than assumed
      rate: taxable.gt(0) ? Number(total.div(taxable).mul(100).toDecimalPlaces(0)) : 0,
      grossAdvance: gross, taxableValue: taxable,
      cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst,
    })
  }

  // 11B reads the adjustment postings, which is where the reversal actually lives
  const adjustments = await prisma.journalEntry.findMany({
    where: {
      companyId, sourceType: 'RECEIPT', date: { gte: from, lte: to },
      narration: { contains: 'adjusted against' },
    },
    include: { lines: { include: { account: true } } },
    orderBy: { date: 'asc' },
  })
  const advancesAdjusted = adjustments.map((e) => {
    const net = (code: string) => e.lines
      .filter((l) => l.account.code === code)
      .reduce((a, l) => a.plus(l.debit.toString()).minus(l.credit.toString()), ZERO)
    const [, number = '', against = ''] = /^Advance (\S+) adjusted against (\S+)$/.exec(e.narration) ?? []
    return {
      number, date: e.date, customerName: '', againstInvoice: against,
      amount: e.lines.filter((l) => l.account.code === '1100').reduce((a, l) => a.plus(l.credit.toString()), ZERO),
      cgst: net('2110'), sgst: net('2120'), igst: net('2130'),
    }
  })

  /**
   * 🔴 A refund is an adjustment of an advance, not a credit note.
   *
   * There is no invoice to credit — the supply never happened — so s.34 has nothing to work
   * on. What the tax paid under s.13(2) needs is to come back out of the liability, and
   * table 11B is where the return does that. ⚠️ Confirm the presentation with the CA: the
   * portal labels 11B "adjustment of advances" and does not say the word refund, so some
   * advisers amend 11A of the original period instead.
   */
  const refunds = await refundsInPeriod(companyId, from, to)
  const advancesRefunded = refunds.map((r) => ({
    number: r.number, date: r.date,
    customerName: r.customer.name, againstReceipt: r.receipt.number,
    amount: new Decimal(r.amount.toString()),
    cgst: new Decimal(r.cgst.toString()),
    sgst: new Decimal(r.sgst.toString()),
    igst: new Decimal(r.igst.toString()),
  }))

  if (advancesRefunded.length > 0) {
    warnings.push(
      `${advancesRefunded.length} refund voucher${advancesRefunded.length === 1 ? '' : 's'} in table 11B. ` +
      'An advance returned without a supply is not a credit note — there is no invoice to credit — so the ' +
      'tax declared when it arrived is taken back as an adjustment of advances. ⚠️ Confirm the presentation ' +
      'with the CA.',
    )
  }

  if (advancesReceived.length > 0) {
    warnings.push(
      `${advancesReceived.length} advance${advancesReceived.length === 1 ? '' : 's'} in table 11A — GST on an ` +
      'advance for SERVICES is payable when the money arrives (s.13(2)). The relief in Notification 66/2017 ' +
      'covers goods only.',
    )
  }

  // ── Table 9C: amendments to notes filed earlier ─────────────────────────────
  const noteAmendments = await noteAmendmentsForPeriod(companyId, from, to)
  const amendedNotes = noteAmendments.map((a) => ({
    number: a.note.number,
    noteDate: a.note.date,
    noteType: a.note.noteType,
    againstInvoice: a.note.invoice?.number ?? null,
    originalPeriod: a.originalPeriod,
    gstin: a.note.invoice?.billToGstin ?? null,
    placeOfSupply: a.note.invoice?.placeOfSupply ?? null,
    original: {
      taxableValue: new Decimal(a.originalTaxableValue.toString()),
      cgst: new Decimal(a.originalCgst.toString()),
      sgst: new Decimal(a.originalSgst.toString()),
      igst: new Decimal(a.originalIgst.toString()),
    },
    revised: {
      taxableValue: new Decimal(a.revisedTaxableValue.toString()),
      cgst: new Decimal(a.revisedCgst.toString()),
      sgst: new Decimal(a.revisedSgst.toString()),
      igst: new Decimal(a.revisedIgst.toString()),
    },
  }))
  if (amendedNotes.length > 0) {
    warnings.push(
      `${amendedNotes.length} note amendment${amendedNotes.length === 1 ? '' : 's'} in table 9C. Each quotes the ` +
      'original note number and date and supersedes what was filed — the original stays as it was reported.',
    )
  }

  // ── Table 9A: amendments to invoices filed earlier ──────────────────────────
  const amendments = await amendmentsForPeriod(companyId, from, to)
  const amendedInvoices = amendments.map((a) => ({
    originalNumber: a.invoice.number,
    originalDate: a.invoice.date,
    originalPeriod: a.originalPeriod,
    gstin: a.revisedGstin,
    placeOfSupply: a.revisedPlaceOfSupply,
    reason: a.reason,
    taxableValue: new Decimal(a.revisedTaxableValue.toString()),
    cgst: new Decimal(a.revisedCgst.toString()),
    sgst: new Decimal(a.revisedSgst.toString()),
    igst: new Decimal(a.revisedIgst.toString()),
    invoiceValue: new Decimal(a.revisedGrandTotal.toString()),
  }))
  if (amendedInvoices.length > 0) {
    warnings.push(
      `${amendedInvoices.length} invoice${amendedInvoices.length === 1 ? '' : 's'} amended in table 9A. ` +
      'The original rows stay in the returns that carried them — 9A supersedes them against the same number and date.',
    )
  }

  // ── HSN / SAC summary ───────────────────────────────────────────────────────
  const hsnMap = new Map<string, HsnRow>()
  for (const inv of live) {
    for (const l of inv.lines) {
      const sac = l.sacCode ?? 'UNSPECIFIED'
      const acc = hsnMap.get(sac) ?? { sac, description: l.description, uqc: 'OTH', quantity: ZERO, taxableValue: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO }
      hsnMap.set(sac, {
        ...acc,
        quantity: acc.quantity.plus(l.quantity.toString()),
        taxableValue: acc.taxableValue.plus(l.taxableValue.toString()),
        cgst: acc.cgst.plus(l.cgst.toString()),
        sgst: acc.sgst.plus(l.sgst.toString()),
        igst: acc.igst.plus(l.igst.toString()),
      })
    }
  }
  if (hsnMap.has('UNSPECIFIED')) {
    warnings.push('Some lines carry no SAC code. At Adpedia’s turnover a 4-digit SAC is mandatory on B2B invoices (Notification 78/2020).')
  }
  if (commercial > 0) {
    warnings.push(
      `${commercial} commercial credit note${commercial === 1 ? ' is' : 's are'} deliberately left out of the cdnr table — ` +
      'the s.34(2) deadline had passed, so no GST is being recovered on them.',
    )
  }

  // ── Document series summary ─────────────────────────────────────────────────
  const docs = buildDocsSummary(invoices)

  const totals = live.reduce(
    (a, i) => ({
      taxableValue: a.taxableValue.plus(i.taxableValue.toString()),
      cgst: a.cgst.plus(i.cgst.toString()),
      sgst: a.sgst.plus(i.sgst.toString()),
      igst: a.igst.plus(i.igst.toString()),
      invoiceValue: a.invoiceValue.plus(i.grandTotal.toString()),
    }),
    { taxableValue: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, invoiceValue: ZERO },
  )

  return {
    period: { label, from, to },
    gstin: company.gstin ?? '',
    b2b, b2cs: [...b2csMap.values()], exports, creditNotes, amendedInvoices,
    amendedNotes,
    advancesReceived, advancesAdjusted, advancesRefunded,
    hsn: [...hsnMap.values()].sort((a, b) => a.sac.localeCompare(b.sac)),
    docs, totals, warnings,
  }
}

function buildDocsSummary(invoices: { number: string; docType: string; status: string }[]) {
  const byType = new Map<string, string[]>()
  const cancelled = new Map<string, number>()
  for (const i of invoices) {
    if (i.number.startsWith('DRAFT-')) continue
    const list = byType.get(i.docType) ?? []
    list.push(i.number)
    byType.set(i.docType, list)
    if (i.status === 'CANCELLED') cancelled.set(i.docType, (cancelled.get(i.docType) ?? 0) + 1)
  }
  return [...byType.entries()].map(([type, numbers]) => {
    const sorted = numbers.sort()
    return {
      type: type.replace('_', ' ').toLowerCase(),
      from: sorted[0], to: sorted[sorted.length - 1],
      total: sorted.length, cancelled: cancelled.get(type) ?? 0,
    }
  })
}
