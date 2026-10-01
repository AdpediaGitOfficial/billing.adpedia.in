import Decimal from 'decimal.js'

// Banking-grade config: enough precision for intermediate work, explicit rounding at the edges.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }
export type Money = Decimal

export const ZERO = new Decimal(0)

export function money(v: Decimal.Value): Decimal {
  return new Decimal(v)
}

/**
 * Round to paise, HALF_UP.
 * 🔴 Apply per line, then sum. Never sum then round — see docs/12 §3.2.
 */
export function round2(v: Decimal.Value): Decimal {
  return new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

/** Round to whole rupees — used for invoice grand totals. */
export function round0(v: Decimal.Value): Decimal {
  return new Decimal(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
}

export function sum(values: Decimal.Value[]): Decimal {
  return values.reduce<Decimal>((a, b) => a.plus(b), new Decimal(0))
}

export function sumBy<T>(rows: T[], key: (r: T) => Decimal.Value): Decimal {
  return rows.reduce<Decimal>((a, r) => a.plus(new Decimal(key(r))), new Decimal(0))
}

/** Split a tax amount into CGST + SGST without losing a paisa to double rounding. */
export function halveTax(tax: Decimal): { cgst: Decimal; sgst: Decimal } {
  const cgst = round2(tax.div(2))
  return { cgst, sgst: round2(tax.minus(cgst)) }
}

/** Indian digit grouping: 944000 -> "9,44,000.00" */
export function formatINR(v: Decimal.Value, opts: { decimals?: boolean; symbol?: boolean } = {}) {
  const { decimals = true, symbol = true } = opts
  const d = new Decimal(v)
  const neg = d.isNegative()
  const fixed = d.abs().toFixed(decimals ? 2 : 0)
  const [whole, frac] = fixed.split('.')

  let grouped: string
  if (whole.length <= 3) {
    grouped = whole
  } else {
    const last3 = whole.slice(-3)
    const rest = whole.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
  }

  const body = frac ? `${grouped}.${frac}` : grouped
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${body}`
}

/** Dashboard-only compact form: ₹25.4L, ₹1.2Cr. Never use in a ledger or a PDF. */
export function formatCompactINR(v: Decimal.Value): string {
  const d = new Decimal(v)
  const abs = d.abs()
  const sign = d.isNegative() ? '-' : ''
  if (abs.gte(1_00_00_000)) return `${sign}₹${abs.div(1_00_00_000).toFixed(2).replace(/\.?0+$/, '')}Cr`
  if (abs.gte(1_00_000)) return `${sign}₹${abs.div(1_00_000).toFixed(1).replace(/\.0$/, '')}L`
  if (abs.gte(1_000)) return `${sign}₹${abs.div(1_000).toFixed(1).replace(/\.0$/, '')}K`
  return formatINR(d, { decimals: false })
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10), o = n % 10
  return TENS[t] + (o ? ' ' + ONES[o] : '')
}

/** Indian numbering system, for the invoice's "amount in words" — a Rule 46 requirement. */
export function amountInWords(v: Decimal.Value, currency = 'Indian Rupees'): string {
  const d = round2(v)
  const whole = d.abs().floor().toNumber()
  const paise = d.abs().minus(d.abs().floor()).mul(100).round().toNumber()

  if (whole === 0 && paise === 0) return `${currency} Zero Only`

  const parts: string[] = []
  const crore = Math.floor(whole / 1_00_00_000)
  const lakh = Math.floor((whole % 1_00_00_000) / 1_00_000)
  const thousand = Math.floor((whole % 1_00_000) / 1_000)
  const hundred = Math.floor((whole % 1_000) / 100)
  const rest = whole % 100

  if (crore) parts.push(`${twoDigits(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundred) parts.push(`${ONES[hundred]} Hundred`)
  if (rest) parts.push(twoDigits(rest))

  let out = `${currency} ${parts.join(' ')}`
  if (paise) out += ` and ${twoDigits(paise)} Paise`
  return `${out} Only`
}
