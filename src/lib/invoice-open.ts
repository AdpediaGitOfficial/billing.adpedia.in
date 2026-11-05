import { Decimal, ZERO } from '@/lib/money'

/**
 * What an invoice still asks for — docs/86.
 *
 * 🔴 THE CREDIT NOTE WAS MISSING FROM EVERY ONE OF THESE FIGURES.
 *
 * A credit note credits 1100 Accounts Receivable. The trial balance knows, the balance sheet
 * knows, and the client's own running account (docs/84) knows — it reads journal lines, so it
 * cannot not know. Nothing that computed "what is still owed on this invoice" did: nine
 * places took `grandTotal`, subtracted `amountReceived` and `tdsCredited`, and stopped.
 *
 * So after a ₹23,600 credit note on a ₹1,18,000 invoice, the ageing, both ageing reports, the
 * dashboard, the chase list, the receipt screen, the month view and the client P&L all said
 * ₹1,18,000 was owed while the ledger said ₹94,400 — and `createReceipt` **accepted a payment
 * of ₹1,18,000**, because its over-allocation guard used the same arithmetic. The company
 * would have banked money it had already given back and shown the invoice as paid.
 *
 * A debit note is the same defect mirrored: it debits 1100 for additional value, so more is
 * owed than the invoice says, and the ageing never asked for it.
 *
 * Stated once, here, in the shape of `lib/settlement.ts`: pure, so the arithmetic can be
 * tested without a database, and shared, so the manual path, the bank matcher and the reports
 * cannot drift apart again. The note totals come from `noteTotals` in one query.
 */

/** Credit and debit notes still standing against one invoice. Cancelled notes are excluded. */
export interface NoteTotals {
  /** live CREDIT notes, gross — what the client no longer owes */
  credited: Decimal
  /** live DEBIT notes, gross — additional value charged against the same invoice */
  debited: Decimal
}

export const NO_NOTES: NoteTotals = { credited: ZERO, debited: ZERO }

/** The columns this needs off an Invoice row. Prisma hands them over as Decimal-likes. */
export interface InvoiceFigures {
  grandTotal: unknown
  amountReceived: unknown
  tdsCredited: unknown
  /** the TDS computed when the invoice was raised — what the client is expected to withhold */
  tdsAmount: unknown
}

export interface InvoiceOpen {
  /** the invoice as issued */
  issued: Decimal
  credited: Decimal
  debited: Decimal
  /** the invoice as it now stands: issued − credited + debited. What 1100 carries. */
  gross: Decimal
  received: Decimal
  tdsCredited: Decimal
  /** TDS the client is expected to withhold and has not yet paid over */
  tdsExpected: Decimal
  /** gross less everything already settled — what the client's ledger says they owe */
  outstanding: Decimal
  /** cash still collectible: outstanding less the TDS that will never arrive as cash */
  collectible: Decimal
  /** true once nothing is left to settle, within the half-rupee tolerance used throughout */
  settled: boolean
}

const dec = (v: unknown) => new Decimal(String(v ?? '0'))

export function invoiceOpen(inv: InvoiceFigures, notes: NoteTotals = NO_NOTES): InvoiceOpen {
  const issued = dec(inv.grandTotal)
  const credited = dec(notes.credited)
  const debited = dec(notes.debited)
  const gross = issued.minus(credited).plus(debited)

  const received = dec(inv.amountReceived)
  const tdsCredited = dec(inv.tdsCredited)
  const outstanding = Decimal.max(gross.minus(received).minus(tdsCredited), ZERO)

  /**
   * 🔴 Capped at what is outstanding, never scaled down pro rata.
   *
   * `tdsAmount` is the tax computed on the invoice as issued. Credit half of it away and the
   * client will deduct on the reduced value, so the figure here is high — but inventing a
   * proportional deduction would be inventing a tax position, and the cap is the same
   * reasoning `settleInFull` already applies: the withholding cannot exceed the debt. Erring
   * high understates what is collectible, which under-chases rather than over-chases.
   */
  const tdsExpected = Decimal.min(Decimal.max(dec(inv.tdsAmount).minus(tdsCredited), ZERO), outstanding)
  const collectible = Decimal.max(outstanding.minus(tdsExpected), ZERO)

  return {
    issued, credited, debited, gross,
    received, tdsCredited, tdsExpected, outstanding, collectible,
    settled: received.plus(tdsCredited).gte(gross.minus('0.5')),
  }
}
