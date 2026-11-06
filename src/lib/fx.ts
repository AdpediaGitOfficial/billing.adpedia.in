import { Decimal, round2, formatINR } from '@/lib/money'

/**
 * docs/91 — the books are in rupees; a document may be in anything.
 *
 * 🔴 `Invoice.fxRate` defaulted to 1 and was read nowhere, so a USD 250 invoice posted ₹250.
 * The rate is rupees per ONE unit of the document currency, on the date of the document,
 * and it is typed by the person issuing it: there is no rate source in this system and one
 * invented here would turn a wrong number into a confident one.
 *
 * The default of 1 is kept as the "not entered" state for a foreign document, because no
 * foreign currency trades at exactly one rupee. That is what `rateIsSet` tests.
 */
export const BOOKS_CURRENCY = 'INR'

export const isForeign = (currency: string | null | undefined) => !!currency && currency !== BOOKS_CURRENCY

/** Rupee value of a document-currency amount at `rate`. The only place this is rounded. */
export const toInr = (amount: Decimal.Value, rate: Decimal.Value): Decimal =>
  round2(new Decimal(amount).mul(rate))

/**
 * The rupees a document-currency figure stands for in the books: the document's own rate, which
 * is the one its receivable was booked at. Anything that adds invoice amounts into a rupee total
 * goes through here — adding a USD figure to a rupee one is the defect docs/91 closes.
 */
export const inrOf = (doc: { currency: string; fxRate: Decimal.Value }, amount: Decimal.Value): Decimal =>
  isForeign(doc.currency) ? toInr(amount, doc.fxRate) : new Decimal(amount)

/** A document in rupees needs no rate; a foreign one needs a rate other than the default 1. */
export function rateIsSet(currency: string, rate: Decimal.Value): boolean {
  if (!isForeign(currency)) return true
  const r = new Decimal(rate)
  return r.gt(0) && !r.eq(1)
}

/** Parse what the form sent. Null when absent or not a positive number with at most 6 places. */
export function parseFxRate(raw: string | null | undefined): Decimal | null {
  if (raw == null || raw.trim() === '') return null
  if (!/^\d+(\.\d{1,6})?$/.test(raw.trim())) return null
  const r = new Decimal(raw.trim())
  return r.gt(0) ? r : null
}

/**
 * An amount in the currency it is IN: rupees get the rupee sign and Indian grouping, anything
 * else is "USD 6,500.00". The chase letters and push messages printed every invoice as ₹, so a
 * client owing USD 250 was asked for ₹250.
 */
export function formatDocAmount(currency: string, v: Decimal.Value): string {
  if (!isForeign(currency)) return formatINR(v)
  return `${currency} ${new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
