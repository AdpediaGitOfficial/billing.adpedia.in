/**
 * Pull the fields that matter off an OCR'd receipt.
 *
 * This is deliberately a pure function over text: the OCR engine is swappable and runs in
 * the browser, but the rules for reading an Indian GST receipt are the valuable part and
 * they belong under test. Everything returned is a SUGGESTION — the form pre-fills, the
 * person confirms. OCR on a crumpled thermal receipt is wrong often enough that
 * auto-submitting its output would be worse than typing.
 */

export interface ExtractedReceipt {
  /** the amount the customer actually paid, i.e. the gross total */
  total: string | null
  taxableValue: string | null
  gstAmount: string | null
  gstRatePct: string | null
  date: string | null
  gstin: string | null
  vendorName: string | null
  /** every money figure found, largest first — for a "did we pick the right one?" chooser */
  candidateAmounts: string[]
  confidence: 'high' | 'medium' | 'low'
}

/** 15 chars: 2 state + 10 PAN + 1 entity + 1 Z + 1 checksum. */
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])\b/
const PAN_IN_GSTIN = /^\d{2}([A-Z]{5}\d{4}[A-Z])/

/** ₹1,23,456.78 | 1234.56 | INR 1,234 — Indian grouping is 2,2,3 not 3,3,3. */
const MONEY_RE = /(?:₹|INR|RS\.?)\s*([\d,]+(?:\.\d{1,2})?)|(?<![\d.])([\d]{1,3}(?:,\d{2})*(?:,\d{3})(?:\.\d{1,2})?)(?![\d])|(?<![\d.,])(\d+\.\d{2})(?![\d])/gi

const TOTAL_HINTS = /\b(grand\s*total|total\s*amount|net\s*payable|amount\s*payable|bill\s*total|total)\b/i
const TAXABLE_HINTS = /\b(taxable\s*(value|amount)|sub\s*total|subtotal|basic)\b/i
/** 🔴 an intra-state receipt splits the tax over two lines; they must be ADDED */
const GST_COMPONENT_HINTS = /\b(cgst|sgst|utgst|igst)\b/i
const GST_GENERIC_HINTS = /\b(gst|tax)\b/i

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function fmt(n: number): string {
  return n.toFixed(2)
}

/** Dates on receipts: 01/10/2026, 1-10-26, 01 Oct 2026, 2026-10-01. Day-first in India. */
function parseDate(text: string): string | null {
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    const [, y, m, d] = iso
    return valid(+y, +m, +d)
  }

  const named = text.match(/\b(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,-]*(\d{2,4})\b/i)
  if (named) {
    const [, d, mon, y] = named
    return valid(fullYear(+y), MONTHS.indexOf(mon.toLowerCase()) + 1, +d)
  }

  // 🔴 day-first. 01/10/2026 is 1 October in India, never 10 January — reading it the
  // American way silently lands the expense in the wrong GST return period.
  const numeric = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/)
  if (numeric) {
    const [, d, m, y] = numeric
    return valid(fullYear(+y), +m, +d)
  }
  return null

  function fullYear(y: number) { return y < 100 ? 2000 + y : y }
  function valid(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
}

function amountsOnLine(line: string): number[] {
  const out: number[] = []
  for (const m of line.matchAll(MONEY_RE)) {
    const raw = m[1] ?? m[2] ?? m[3]
    const n = raw ? toNumber(raw) : null
    if (n !== null && n > 0) out.push(n)
  }
  return out
}

export function extractReceiptFields(text: string): ExtractedReceipt {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  const gstinMatch = text.toUpperCase().match(GSTIN_RE)
  const gstin = gstinMatch ? gstinMatch[1] : null

  // the label and its number are often on the same line; sometimes the next one
  const labelled = (re: RegExp): number | null => {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      const here = amountsOnLine(lines[i])
      if (here.length) return Math.max(...here)
      const next = lines[i + 1] ? amountsOnLine(lines[i + 1]) : []
      if (next.length) return Math.max(...next)
    }
    return null
  }

  const all = lines.flatMap(amountsOnLine)
  const totalLabelled = labelled(TOTAL_HINTS)
  const taxableLabelled = labelled(TAXABLE_HINTS)

  // 🔴 CGST and SGST are two halves of one tax and sit on separate lines. Taking the
  // larger of them — or either one alone — halves the tax and makes the receipt look
  // like it does not add up, which then discards both figures. Sum the components.
  const componentLines = lines.filter((l) => GST_COMPONENT_HINTS.test(l))
  const gstLabelled = componentLines.length > 0
    ? componentLines.reduce((acc, l) => {
        const amounts = amountsOnLine(l)
        return amounts.length ? acc + Math.max(...amounts) : acc
      }, 0) || null
    : labelled(GST_GENERIC_HINTS)

  // Without a "total" label, the largest figure on the receipt is the best guess —
  // it is nearly always the gross, since every component is smaller than the sum.
  const total = totalLabelled ?? (all.length ? Math.max(...all) : null)

  let taxableValue = taxableLabelled
  let gstAmount = gstLabelled
  let gstRatePct: string | null = null

  // Reconcile the three. If two are known the third follows, and a receipt whose parts
  // do not add up is a receipt we have misread — better to drop the weak field than to
  // pre-fill a figure that is confidently wrong.
  if (total !== null && taxableValue !== null && gstAmount === null) {
    gstAmount = Math.round((total - taxableValue) * 100) / 100
  } else if (total !== null && gstAmount !== null && taxableValue === null) {
    taxableValue = Math.round((total - gstAmount) * 100) / 100
  }
  if (total !== null && taxableValue !== null && gstAmount !== null) {
    const adds = Math.abs(taxableValue + gstAmount - total) <= 1
    if (!adds) { taxableValue = null; gstAmount = null }
  }
  if (taxableValue !== null && gstAmount !== null && taxableValue > 0) {
    const pct = (gstAmount / taxableValue) * 100
    // snap to a real GST slab — OCR noise of a rupee should not produce "17.98%"
    const slab = [5, 12, 18, 28].find((r) => Math.abs(pct - r) < 1)
    gstRatePct = slab ? String(slab) : null
  }

  // the vendor's name is usually the first substantial line, above the address
  const vendorName = lines.find((l) =>
    l.length >= 4 && /[A-Za-z]{3}/.test(l) && !GSTIN_RE.test(l.toUpperCase()) &&
    !/^(tax\s*)?invoice|^receipt|^bill\b/i.test(l) && amountsOnLine(l).length === 0,
  ) ?? null

  const date = parseDate(text)

  // Confidence drives how loudly the UI asks for a second look.
  const hits = [total !== null, date !== null, gstin !== null, gstRatePct !== null].filter(Boolean).length
  const confidence = hits >= 3 ? 'high' : hits === 2 ? 'medium' : 'low'

  return {
    total: total !== null ? fmt(total) : null,
    taxableValue: taxableValue !== null ? fmt(taxableValue) : null,
    gstAmount: gstAmount !== null ? fmt(gstAmount) : null,
    gstRatePct,
    date,
    gstin,
    vendorName,
    candidateAmounts: [...new Set(all)].sort((a, b) => b - a).map(fmt),
    confidence,
  }
}

/** The PAN embedded in a GSTIN — lets a scanned receipt be matched to a known vendor. */
export function panFromGstin(gstin: string): string | null {
  const m = gstin.toUpperCase().match(PAN_IN_GSTIN)
  return m ? m[1] : null
}
