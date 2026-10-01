import { Decimal, ZERO, round2 } from '@/lib/money'

/**
 * Build an IRP payload — e-invoice schema 1.1 (INV-01).
 *
 * This is a pure function over already-computed invoice figures, deliberately with no
 * database and no network, because the IRP rejects a payload outright and its error codes
 * are terse. Everything that can be checked offline is checked here, where a test can
 * prove it, rather than discovered as a 2172 on a live invoice that is already numbered.
 */

export type SupplyType = 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' | 'DEXP'

export interface EInvoiceParty {
  gstin: string | null
  legalName: string
  address1: string
  address2?: string | null
  location: string
  pincode: string | null
  stateCode: string | null
  phone?: string | null
  email?: string | null
}

export interface EInvoiceLine {
  slNo: number
  description: string
  /** services carry SAC; IsServc is driven off this */
  isService: boolean
  hsnOrSac: string | null
  quantity: Decimal
  unit: string
  unitPrice: Decimal
  taxableValue: Decimal
  gstRatePct: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  total: Decimal
}

export interface EInvoiceInput {
  docType: 'INV' | 'CRN' | 'DBN'
  number: string
  date: Date
  taxMode: 'INTRA' | 'INTER' | 'EXPORT'
  /** exports go under LUT (without payment of tax) or with payment */
  exportWithPayment?: boolean
  isSez?: boolean
  reverseCharge?: boolean
  seller: EInvoiceParty
  buyer: EInvoiceParty
  lines: EInvoiceLine[]
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  grandTotal: Decimal
  currency?: string
  /** required on exports */
  countryCode?: string | null
  portCode?: string | null
}

export interface ValidationIssue { field: string; message: string }

/* ── validation ─────────────────────────────────────────────────────────────── */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/
/**
 * Rule 46 and the IRP agree: 16 chars, and it may not START with 0, / or -.
 * 🔴 The leading character class excludes 0 deliberately — [A-Za-z0-9] would admit it and
 * quietly contradict the rule this regex exists to enforce.
 */
const DOC_NO_RE = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/

/** Overseas buyers: PIN 999999, state code 96, place of supply 96. */
const EXPORT_PIN = '999999'
const EXPORT_STATE = '96'

export function validateEInvoice(input: EInvoiceInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (field: string, message: string) => issues.push({ field, message })

  // ── document ──
  if (!DOC_NO_RE.test(input.number)) {
    add('DocDtls.No', `"${input.number}" is not a valid document number — up to 16 characters, letters, digits, / and -, and it may not start with 0, / or -`)
  }
  if (input.number.length > 16) {
    add('DocDtls.No', `"${input.number}" is ${input.number.length} characters; the IRP limit is 16`)
  }

  // ── seller ──
  if (!input.seller.gstin || !GSTIN_RE.test(input.seller.gstin)) {
    add('SellerDtls.Gstin', 'The seller GSTIN is missing or malformed')
  }
  if (!input.seller.pincode || !/^\d{6}$/.test(input.seller.pincode)) {
    add('SellerDtls.Pin', 'Seller PIN code must be six digits')
  }
  if (!input.seller.stateCode) add('SellerDtls.Stcd', 'Seller state code is required')

  // ── buyer ──
  const isExport = input.taxMode === 'EXPORT'
  if (isExport) {
    // 🔴 An overseas buyer has no GSTIN. The IRP wants URP, PIN 999999 and state 96 —
    // sending the seller's own state here is the classic export rejection.
    if (input.buyer.gstin && input.buyer.gstin !== 'URP' && !GSTIN_RE.test(input.buyer.gstin)) {
      add('BuyerDtls.Gstin', 'An overseas buyer must be URP, not a malformed GSTIN')
    }
    if (!input.countryCode || input.countryCode.length !== 2) {
      add('ExpDtls.CntCode', 'Exports need the buyer’s two-letter country code')
    }
  } else {
    if (!input.buyer.gstin || !GSTIN_RE.test(input.buyer.gstin)) {
      add('BuyerDtls.Gstin', 'A B2B e-invoice needs a valid buyer GSTIN — B2C invoices are not eligible for an IRN at all')
    }
    if (!input.buyer.pincode || !/^\d{6}$/.test(input.buyer.pincode)) {
      add('BuyerDtls.Pin', 'Buyer PIN code must be six digits')
    }
    if (!input.buyer.stateCode) add('BuyerDtls.Pos', 'Place of supply is required')
  }

  // ── lines ──
  if (input.lines.length === 0) add('ItemList', 'An e-invoice needs at least one line')
  if (input.lines.length > 1000) add('ItemList', 'The IRP accepts at most 1000 lines on one document')

  for (const l of input.lines) {
    const where = `ItemList[${l.slNo}]`
    if (!l.hsnOrSac) {
      add(`${where}.HsnCd`, `Line ${l.slNo} has no HSN/SAC code — the IRP rejects a line without one`)
    } else if (!/^\d{4,8}$/.test(l.hsnOrSac)) {
      add(`${where}.HsnCd`, `"${l.hsnOrSac}" is not a 4–8 digit HSN/SAC code`)
    }

    // 🔴 Each line must foot: taxable + its taxes = line total. The IRP checks this to
    // ±1 rupee and rejects the whole document, not the line.
    const lineSum = l.taxableValue.plus(l.cgst).plus(l.sgst).plus(l.igst)
    if (lineSum.minus(l.total).abs().gt('1')) {
      add(`${where}.TotItemVal`, `Line ${l.slNo} does not add up: ${l.taxableValue} + tax ≠ ${l.total}`)
    }

    // the tax actually charged must match the rate claimed
    const expected = round2(l.taxableValue.mul(l.gstRatePct).div(100))
    const charged = l.cgst.plus(l.sgst).plus(l.igst)
    if (charged.minus(expected).abs().gt('1')) {
      add(`${where}.GstRt`, `Line ${l.slNo} claims ${l.gstRatePct}% but carries ${charged} of tax on ${l.taxableValue}`)
    }
  }

  // ── the split must match the supply type ──
  if (input.taxMode === 'INTRA' && input.igst.gt(0)) {
    add('ValDtls.IgstVal', 'An intra-state supply cannot carry IGST')
  }
  if (input.taxMode === 'INTER' && (input.cgst.gt(0) || input.sgst.gt(0))) {
    add('ValDtls.CgstVal', 'An inter-state supply cannot carry CGST or SGST')
  }
  if (isExport && !input.exportWithPayment && (input.cgst.gt(0) || input.sgst.gt(0) || input.igst.gt(0))) {
    add('ValDtls', 'An export under LUT is zero-rated — it must carry no tax')
  }

  // ── totals must equal the sum of lines ──
  const sum = (pick: (l: EInvoiceLine) => Decimal) => input.lines.reduce((a, l) => a.plus(pick(l)), ZERO)
  const checks: [string, Decimal, Decimal][] = [
    ['ValDtls.AssVal', sum((l) => l.taxableValue), input.taxableValue],
    ['ValDtls.CgstVal', sum((l) => l.cgst), input.cgst],
    ['ValDtls.SgstVal', sum((l) => l.sgst), input.sgst],
    ['ValDtls.IgstVal', sum((l) => l.igst), input.igst],
    ['ValDtls.TotInvVal', sum((l) => l.total), input.grandTotal],
  ]
  for (const [field, lines, header] of checks) {
    if (lines.minus(header).abs().gt('1')) {
      add(field, `Header says ${header} but the lines add up to ${lines}`)
    }
  }

  return issues
}

/* ── the payload ────────────────────────────────────────────────────────────── */

/** dd/mm/yyyy — the only date format the IRP accepts. */
function irpDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}

const n2 = (v: Decimal) => Number(v.toFixed(2))

export function supplyTypeFor(input: EInvoiceInput): SupplyType {
  if (input.taxMode === 'EXPORT') return input.exportWithPayment ? 'EXPWP' : 'EXPWOP'
  if (input.isSez) return input.exportWithPayment ? 'SEZWP' : 'SEZWOP'
  return 'B2B'
}

export function buildEInvoicePayload(input: EInvoiceInput): Record<string, unknown> {
  const isExport = input.taxMode === 'EXPORT'
  const pos = isExport ? EXPORT_STATE : (input.buyer.stateCode ?? input.seller.stateCode ?? '')

  return {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: supplyTypeFor(input),
      RegRev: input.reverseCharge ? 'Y' : 'N',
      // IGST charged on a supply that is otherwise intra-state — not our case, but the
      // field is mandatory and the IRP cross-checks it against the tax split
      IgstOnIntra: input.taxMode === 'INTRA' && input.igst.gt(0) ? 'Y' : 'N',
    },
    DocDtls: { Typ: input.docType, No: input.number, Dt: irpDate(input.date) },
    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.legalName,
      Addr1: input.seller.address1,
      ...(input.seller.address2 ? { Addr2: input.seller.address2 } : {}),
      Loc: input.seller.location,
      Pin: Number(input.seller.pincode),
      Stcd: input.seller.stateCode,
      ...(input.seller.phone ? { Ph: input.seller.phone } : {}),
      ...(input.seller.email ? { Em: input.seller.email } : {}),
    },
    BuyerDtls: {
      Gstin: isExport ? 'URP' : input.buyer.gstin,
      LglNm: input.buyer.legalName,
      Pos: pos,
      Addr1: input.buyer.address1,
      ...(input.buyer.address2 ? { Addr2: input.buyer.address2 } : {}),
      Loc: input.buyer.location,
      Pin: Number(isExport ? EXPORT_PIN : input.buyer.pincode),
      Stcd: isExport ? EXPORT_STATE : input.buyer.stateCode,
    },
    ...(isExport ? {
      ExpDtls: {
        ShipBNo: null, ShipBDt: null,
        Port: input.portCode ?? null,
        RefClm: input.exportWithPayment ? 'Y' : 'N',
        ForCur: input.currency ?? 'USD',
        CntCode: input.countryCode,
      },
    } : {}),
    ItemList: input.lines.map((l) => ({
      SlNo: String(l.slNo),
      PrdDesc: l.description.slice(0, 300),
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsnOrSac,
      Qty: Number(l.quantity.toFixed(3)),
      Unit: l.unit,
      UnitPrice: Number(l.unitPrice.toFixed(3)),
      TotAmt: n2(l.taxableValue),
      AssAmt: n2(l.taxableValue),
      GstRt: Number(l.gstRatePct.toFixed(2)),
      IgstAmt: n2(l.igst),
      CgstAmt: n2(l.cgst),
      SgstAmt: n2(l.sgst),
      TotItemVal: n2(l.total),
    })),
    ValDtls: {
      AssVal: n2(input.taxableValue),
      CgstVal: n2(input.cgst),
      SgstVal: n2(input.sgst),
      IgstVal: n2(input.igst),
      TotInvVal: n2(input.grandTotal),
    },
  }
}
