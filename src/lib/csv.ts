/**
 * CSV for spreadsheets — RFC 4180 quoting, plus the two things that bite in practice.
 */

/**
 * 🔴 Formula injection.
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a FORMULA when the file is
 * opened in Excel or Sheets. Every name in these exports is user-entered — a customer, a
 * vendor, an account, a journal narration — so a party called `=HYPERLINK(...)` runs on the
 * accountant's machine when they open the file we sent them. Quoting does not prevent it;
 * only a leading apostrophe does, which the spreadsheet strips on display.
 *
 * 🔴 ...but a negative number also starts with `-`.
 *
 * Naively prefixing every `-` would turn `-71000.00` into the text `'-71000.00` and break
 * every loss, every credit balance and every outflow in a financial export — the figures
 * would import as text and refuse to sum. So a cell that IS a number is left alone.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/
const NUMERIC = /^-?\d+(\.\d+)?$/

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const raw = v instanceof Date ? v.toISOString().slice(0, 10) : String(v)

  const s = FORMULA_LEAD.test(raw) && !NUMERIC.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * 🔴 The BOM is not optional.
 *
 * Excel on Windows reads a BOM-less file as the system codepage, so `Nuvé` becomes `NuvÃ©`
 * and `₹` becomes mojibake. Every other reader ignores it.
 */
export const UTF8_BOM = '﻿'

export function toCsv(lines: string[]): string {
  // CRLF per RFC 4180; Excel is the consumer and it is the one that cares
  return UTF8_BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Money for a spreadsheet: a plain decimal string, never a formatted one.
 *
 * 🔴 `formatINR` produces `1,00,300.00`. In a CSV the commas split it across columns, and
 * even quoted it imports as text that will not sum. Indian grouping is a display concern
 * and has no business in an export.
 */
export function csvMoney(v: { toFixed(n: number): string } | string | null | undefined): string {
  if (v === null || v === undefined) return '0.00'
  return typeof v === 'string' ? Number(v).toFixed(2) : v.toFixed(2)
}
