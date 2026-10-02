import { Decimal, ZERO, formatINR } from '@/lib/money'

/**
 * The order of utilisation — s.49(5) read with rule 88A.
 *
 * Pure, and deliberately separate from the service that records a set-off: the order in
 * which credit may be applied is the part with the law in it, and it should be testable
 * without a database anywhere near it.
 */

/* ────────────────────────────────────────────────────────────────────────────
   The engine. Pure, so the order of utilisation can be tested on its own.
   ──────────────────────────────────────────────────────────────────────────── */

export interface LiabilityHeads {
  igst: Decimal
  cgst: Decimal
  sgst: Decimal
  /** reverse charge. IGST major head — but 🔴 cash only, never credit. */
  rcm: Decimal
  interest: Decimal
  lateFee: Decimal
}

export interface CreditHeads { igst: Decimal; cgst: Decimal; sgst: Decimal }

/** The cash ledger is kept per major head, plus one minor head for interest, fee and penalty. */
export interface CashHeads { igst: Decimal; cgst: Decimal; sgst: Decimal; other: Decimal }

export interface CreditUtilisation {
  igstToIgst: Decimal
  igstToCgst: Decimal
  igstToSgst: Decimal
  cgstToCgst: Decimal
  cgstToIgst: Decimal
  sgstToSgst: Decimal
  sgstToIgst: Decimal
  total: Decimal
}

export interface SetOffInput {
  liability: LiabilityHeads
  /** electronic credit ledger balance. RCM input credit is plain IGST credit and merges in. */
  credit: CreditHeads
  /** electronic cash ledger balance */
  cash: CashHeads
}

export interface SetOffPlan {
  credit: CreditUtilisation
  /** cash debited per head. `igst` carries the reverse-charge payment too. */
  cash: CashHeads & { total: Decimal }
  /** of `cash.igst`, the part that went to reverse charge */
  cashToRcm: Decimal
  /** what still has to be deposited, per head — cash heads do not cross */
  shortfall: CashHeads & { total: Decimal }
  discharged: { igst: Decimal; cgst: Decimal; sgst: Decimal; rcm: Decimal; interest: Decimal; lateFee: Decimal; total: Decimal }
  creditClosing: CreditHeads
  cashClosing: CashHeads
  notes: string[]
}

const take = (want: Decimal, have: Decimal) => Decimal.max(Decimal.min(want, have), ZERO)

/**
 * Work out how a liability is discharged — s.49(5) read with rule 88A.
 *
 * The statutory order, and every line of it matters:
 *
 *   s.49(5)(a)  IGST credit → IGST first, then CGST or SGST in any order
 *   rule 88A    CGST and SGST credit may be used only once IGST credit is fully utilised
 *   s.49(5)(b)  CGST credit → CGST, then IGST
 *   s.49(5)(c)  SGST credit → SGST, then IGST
 *   s.49(5)(e)  🔴 CGST credit shall NOT be used for SGST
 *   s.49(5)(f)  🔴 SGST credit shall NOT be used for CGST
 *
 * 🔴 Within "any order" there is a real choice, and the obvious one is wrong. Sending the
 * remaining IGST credit to CGST first can strand CGST credit that has nowhere else to go
 * and leave an SGST shortfall that must be funded in cash — cash that was never due. So it
 * goes first to the heads that would otherwise be short, which is what the portal lets a
 * taxpayer do and what a careful filer does by hand.
 */
export function planSetOff(input: SetOffInput): SetOffPlan {
  const { liability: liab } = input
  let lIgst = liab.igst, lCgst = liab.cgst, lSgst = liab.sgst
  let cIgst = input.credit.igst, cCgst = input.credit.cgst, cSgst = input.credit.sgst
  const notes: string[] = []

  // ── credit, head-wise ──────────────────────────────────────────────────────
  // s.49(5)(a) — IGST credit against IGST liability first
  const igstToIgst = take(lIgst, cIgst)
  lIgst = lIgst.minus(igstToIgst); cIgst = cIgst.minus(igstToIgst)

  // rule 88A — the rest of the IGST credit must be used before any CGST/SGST credit.
  // Direct it at the heads whose own credit will not cover them.
  const shortC = Decimal.max(lCgst.minus(cCgst), ZERO)
  const shortS = Decimal.max(lSgst.minus(cSgst), ZERO)
  let igstToCgst = take(shortC, cIgst)
  cIgst = cIgst.minus(igstToCgst); lCgst = lCgst.minus(igstToCgst)
  let igstToSgst = take(shortS, cIgst)
  cIgst = cIgst.minus(igstToSgst); lSgst = lSgst.minus(igstToSgst)

  // anything still left over — rule 88A wants IGST credit fully utilised before the others
  const spillC = take(lCgst, cIgst)
  cIgst = cIgst.minus(spillC); lCgst = lCgst.minus(spillC); igstToCgst = igstToCgst.plus(spillC)
  const spillS = take(lSgst, cIgst)
  cIgst = cIgst.minus(spillS); lSgst = lSgst.minus(spillS); igstToSgst = igstToSgst.plus(spillS)

  // s.49(5)(b) and (c) — own head first
  const cgstToCgst = take(lCgst, cCgst)
  cCgst = cCgst.minus(cgstToCgst); lCgst = lCgst.minus(cgstToCgst)
  const sgstToSgst = take(lSgst, cSgst)
  cSgst = cSgst.minus(sgstToSgst); lSgst = lSgst.minus(sgstToSgst)

  // ...then the IGST liability. Legal here only because IGST credit is exhausted by now:
  // if any IGST liability survived step one, it is because the IGST credit ran out.
  const cgstToIgst = take(lIgst, cCgst)
  cCgst = cCgst.minus(cgstToIgst); lIgst = lIgst.minus(cgstToIgst)
  const sgstToIgst = take(lIgst, cSgst)
  cSgst = cSgst.minus(sgstToIgst); lIgst = lIgst.minus(sgstToIgst)

  const credit: CreditUtilisation = {
    igstToIgst, igstToCgst, igstToSgst, cgstToCgst, cgstToIgst, sgstToSgst, sgstToIgst,
    total: igstToIgst.plus(igstToCgst).plus(igstToSgst)
      .plus(cgstToCgst).plus(cgstToIgst).plus(sgstToSgst).plus(sgstToIgst),
  }

  // ── cash, head-wise ───────────────────────────────────────────────────────
  // 🔴 Reverse charge is funded first. It has no alternative source — credit can never
  // discharge it — whereas the rest of the IGST head is in the same position only after
  // credit has already been applied above.
  const cashToRcm = take(liab.rcm, input.cash.igst)
  const cashIgstTax = take(lIgst, input.cash.igst.minus(cashToRcm))
  const cashIgst = cashToRcm.plus(cashIgstTax)
  const cashCgst = take(lCgst, input.cash.cgst)
  const cashSgst = take(lSgst, input.cash.sgst)
  const otherDue = liab.interest.plus(liab.lateFee)
  const cashOther = take(otherDue, input.cash.other)

  const shortfall = {
    igst: liab.rcm.plus(lIgst).minus(cashIgst),
    cgst: lCgst.minus(cashCgst),
    sgst: lSgst.minus(cashSgst),
    other: otherDue.minus(cashOther),
    total: ZERO as Decimal,
  }
  shortfall.total = shortfall.igst.plus(shortfall.cgst).plus(shortfall.sgst).plus(shortfall.other)

  const discharged = {
    igst: igstToIgst.plus(cgstToIgst).plus(sgstToIgst).plus(cashIgstTax),
    cgst: igstToCgst.plus(cgstToCgst).plus(cashCgst),
    sgst: igstToSgst.plus(sgstToSgst).plus(cashSgst),
    rcm: cashToRcm,
    // the minor head is one pot; the fee is settled before the interest so that a partial
    // deposit clears the fixed amount rather than part of each
    lateFee: take(liab.lateFee, cashOther),
    interest: ZERO as Decimal,
    total: ZERO as Decimal,
  }
  discharged.interest = take(liab.interest, cashOther.minus(discharged.lateFee))
  discharged.total = discharged.igst.plus(discharged.cgst).plus(discharged.sgst)
    .plus(discharged.rcm).plus(discharged.interest).plus(discharged.lateFee)

  // ── what the taxpayer needs to be told ────────────────────────────────────
  if (igstToCgst.plus(igstToSgst).gt(0)) {
    notes.push(
      `${formatINR(igstToCgst.plus(igstToSgst))} of IGST credit was used against the CGST and SGST liability. ` +
      'Rule 88A requires IGST credit to be exhausted before any CGST or SGST credit is touched; ' +
      'where it goes within that is the filer\'s choice, so it is directed at the heads that would otherwise need cash.',
    )
  }
  if (cCgst.gt(0) && shortfall.sgst.gt(0)) {
    notes.push(
      `${formatINR(cCgst)} of CGST credit is sitting unused and cannot be touched for the ` +
      `${formatINR(shortfall.sgst)} SGST shortfall — s.49(5)(e) forbids it. That shortfall has to be paid in cash.`,
    )
  }
  if (cSgst.gt(0) && shortfall.cgst.gt(0)) {
    notes.push(
      `${formatINR(cSgst)} of SGST credit is sitting unused and cannot be touched for the ` +
      `${formatINR(shortfall.cgst)} CGST shortfall — s.49(5)(f) forbids it. That shortfall has to be paid in cash.`,
    )
  }
  if (liab.rcm.gt(0)) {
    notes.push(
      `${formatINR(liab.rcm)} of reverse-charge tax is funded in cash. Tax payable under reverse charge is ` +
      'not "output tax" (s.2(82)), so s.49(4) does not allow input credit to discharge it, however much credit is available.',
    )
  }
  if (otherDue.gt(0)) {
    notes.push(
      `${formatINR(otherDue)} of interest and late fee is funded in cash. The credit ledger may be used for tax only — ` +
      'never for interest, fee or penalty.',
    )
  }
  if (shortfall.total.gt(0)) {
    const heads = [
      shortfall.igst.gt(0) ? `IGST ${formatINR(shortfall.igst)}` : null,
      shortfall.cgst.gt(0) ? `CGST ${formatINR(shortfall.cgst)}` : null,
      shortfall.sgst.gt(0) ? `SGST ${formatINR(shortfall.sgst)}` : null,
      shortfall.other.gt(0) ? `interest and fee ${formatINR(shortfall.other)}` : null,
    ].filter(Boolean).join(' · ')
    notes.push(
      `A challan is needed before this can be set off — ${heads}.` +
      (liab.rcm.gt(0) ? ' The IGST figure includes the reverse charge, which is deposited under that major head.' : ''),
    )
  }
  const idle = (['igst', 'cgst', 'sgst'] as const).filter((h) => {
    const used = h === 'igst' ? cashIgst : h === 'cgst' ? cashCgst : cashSgst
    return input.cash[h].minus(used).gt(0)
  })
  if (shortfall.total.gt(0) && idle.length > 0) {
    notes.push(
      'Cash under one major head cannot pay another. There is money idle under ' +
      `${idle.map((h) => h.toUpperCase()).join(' and ')} while another head is short — moving it needs Form PMT-09.`,
    )
  }

  return {
    credit,
    cash: { igst: cashIgst, cgst: cashCgst, sgst: cashSgst, other: cashOther, total: cashIgst.plus(cashCgst).plus(cashSgst).plus(cashOther) },
    cashToRcm,
    shortfall,
    discharged,
    creditClosing: { igst: cIgst, cgst: cCgst, sgst: cSgst },
    cashClosing: {
      igst: input.cash.igst.minus(cashIgst),
      cgst: input.cash.cgst.minus(cashCgst),
      sgst: input.cash.sgst.minus(cashSgst),
      other: input.cash.other.minus(cashOther),
    },
    notes,
  }
}
