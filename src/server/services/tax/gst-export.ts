import type { Gstr1 } from './gstr1'
import type { Gstr3b } from './gstr3b'
import { csvCell } from '@/lib/csv'

/** RFC 4180 quoting — a customer name with a comma must not shift every column. */

const row = (cells: unknown[]) => cells.map(csvCell).join(',')
const d2 = (v: { toFixed: (n: number) => string }) => v.toFixed(2)

/**
 * One CSV per GSTR-1 table, concatenated into a single file with section headers.
 * The CA imports the sections they need into the offline utility. Deliberately NOT a
 * JSON payload for the portal — see gstr1.ts.
 */
export function gstr1ToCsv(r: Gstr1): string {
  const out: string[] = []
  const section = (name: string) => { out.push('', `# ${name}`) }

  out.push(`# GSTR-1 export — ${r.period.label}`)
  out.push(`# GSTIN,${r.gstin}`)
  out.push(`# Period,${r.period.from.toISOString().slice(0, 10)} to ${r.period.to.toISOString().slice(0, 10)}`)
  out.push(`# Generated,${new Date().toISOString().slice(0, 10)}`)
  out.push('# Prepared for review — this is not a portal filing')

  section('b2b — Business to Business invoices')
  out.push(row(['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Rate', 'Taxable Value', 'Cess Amount']))
  for (const b of r.b2b) {
    out.push(row([b.gstin, b.customerName, b.invoiceNumber, b.invoiceDate, d2(b.invoiceValue), b.placeOfSupply, b.reverseCharge, b.rate, d2(b.taxableValue), '0.00']))
  }

  section('b2cs — Business to Consumer (small), consolidated')
  out.push(row(['Type', 'Place Of Supply', 'Rate', 'Taxable Value', 'Cess Amount']))
  for (const b of r.b2cs) out.push(row(['OE', b.placeOfSupply, b.rate, d2(b.taxableValue), '0.00']))

  section('exp — Exports')
  out.push(row(['Export Type', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Port Code', 'Shipping Bill Number', 'Shipping Bill Date', 'Rate', 'Taxable Value', 'Currency', 'Recipient', 'LUT ARN']))
  for (const e of r.exports) {
    out.push(row([e.exportType, e.invoiceNumber, e.invoiceDate, d2(e.invoiceValue), '', '', '', 0, d2(e.taxableValue), e.currency, e.customerName, e.lutArn]))
  }

  section('cdnr — Credit / Debit notes (registered)')
  // 🔴 the note type is the first column the portal reads — C or D decides the sign
  out.push(row(['Note Type', 'Note Number', 'Note Date', 'Against Invoice', 'Reason', 'Taxable Value', 'CGST', 'SGST', 'IGST']))
  for (const c of r.creditNotes) {
    out.push(row([
      c.noteType === 'DEBIT' ? 'D' : 'C',
      c.number, c.date, c.againstInvoice, c.reason, d2(c.taxableValue), d2(c.cgst), d2(c.sgst), d2(c.igst),
    ]))
  }

  // 🔴 docs/52 — the amendment tables. The CA imports these into the RPU alongside the rest;
  // leaving them out of the export would mean an amendment recorded here is never filed.
  if (r.amendedInvoices.length > 0) {
    section('b2ba — Amended B2B invoices (table 9A)')
    out.push(row(['Original Invoice No.', 'Original Date', 'Originally Filed In', 'Revised GSTIN', 'Revised Place of Supply', 'Reason', 'Revised Taxable Value', 'CGST', 'SGST', 'IGST', 'Revised Invoice Value']))
    for (const a of r.amendedInvoices) {
      out.push(row([
        a.originalNumber, a.originalDate, a.originalPeriod, a.gstin, a.placeOfSupply, a.reason,
        d2(a.taxableValue), d2(a.cgst), d2(a.sgst), d2(a.igst), d2(a.invoiceValue),
      ]))
    }
  }

  // docs/66 — 9C sits next to 9A, because the CA reconciles the pair together
  if (r.amendedNotes.length > 0) {
    section('cdnra — Amended credit/debit notes (table 9C)')
    out.push(row([
      'Note No.', 'Note Date', 'Type', 'Against Invoice', 'Originally Filed In', 'Recipient GSTIN', 'POS',
      'Original Taxable', 'Original CGST', 'Original SGST', 'Original IGST',
      'Revised Taxable', 'Revised CGST', 'Revised SGST', 'Revised IGST',
    ]))
    for (const a of r.amendedNotes) {
      out.push(row([
        a.number, a.noteDate, a.noteType, a.againstInvoice ?? '', a.originalPeriod, a.gstin ?? '', a.placeOfSupply ?? '',
        d2(a.original.taxableValue), d2(a.original.cgst), d2(a.original.sgst), d2(a.original.igst),
        d2(a.revised.taxableValue), d2(a.revised.cgst), d2(a.revised.sgst), d2(a.revised.igst),
      ]))
    }
  }

  if (r.advancesReceived.length > 0) {
    section('at — Advances received on which tax is payable (table 11A)')
    out.push(row(['Voucher No.', 'Date', 'Customer', 'Place of Supply', 'Rate', 'Gross Advance', 'Taxable Value', 'CGST', 'SGST', 'IGST']))
    for (const a of r.advancesReceived) {
      out.push(row([a.number, a.date, a.customerName, a.placeOfSupply, a.rate, d2(a.grossAdvance), d2(a.taxableValue), d2(a.cgst), d2(a.sgst), d2(a.igst)]))
    }
  }

  if (r.advancesAdjusted.length > 0) {
    section('atadj — Advances adjusted against invoices (table 11B)')
    out.push(row(['Voucher No.', 'Date', 'Against Invoice', 'Amount Adjusted', 'CGST', 'SGST', 'IGST']))
    for (const a of r.advancesAdjusted) {
      out.push(row([a.number, a.date, a.againstInvoice, d2(a.amount), d2(a.cgst), d2(a.sgst), d2(a.igst)]))
    }
  }

  // docs/65 — a refunded advance belongs with the adjustments: both take back tax declared
  // in 11A of an earlier period. It is given its own block so the CA can see which is which.
  if (r.advancesRefunded.length > 0) {
    section('atadj — Advances REFUNDED, no supply made (table 11B · s.31(3)(e))')
    out.push(row(['Refund Voucher', 'Date', 'Customer', 'Against Receipt Voucher', 'Amount Refunded', 'CGST', 'SGST', 'IGST']))
    for (const a of r.advancesRefunded) {
      out.push(row([a.number, a.date, a.customerName, a.againstReceipt, d2(a.amount), d2(a.cgst), d2(a.sgst), d2(a.igst)]))
    }
  }

  section('hsn — HSN/SAC summary')
  out.push(row(['HSN/SAC', 'Description', 'UQC', 'Total Quantity', 'Total Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess']))
  for (const h of r.hsn) {
    out.push(row([h.sac, h.description, h.uqc, h.quantity.toFixed(3), d2(h.taxableValue), d2(h.igst), d2(h.cgst), d2(h.sgst), '0.00']))
  }

  section('docs — Document series issued')
  out.push(row(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled']))
  for (const d of r.docs) out.push(row([d.type, d.from, d.to, d.total, d.cancelled]))

  if (r.warnings.length) {
    section('warnings — review before filing')
    for (const w of r.warnings) out.push(row([w]))
  }

  return out.join('\n') + '\n'
}

export function gstr3bToCsv(r: Gstr3b): string {
  const out: string[] = []
  out.push(`# GSTR-3B summary — ${r.period.label}`)
  out.push(`# Period,${r.period.from.toISOString().slice(0, 10)} to ${r.period.to.toISOString().slice(0, 10)}`)
  out.push('# Prepared for review — this is not a portal filing', '')

  out.push(row(['Table', 'Description', 'Taxable Value', 'IGST', 'CGST', 'SGST']))
  out.push(row(['3.1(a)', 'Outward taxable supplies (other than zero-rated, nil, exempt)', d2(r.t31a.taxable), d2(r.t31a.igst), d2(r.t31a.cgst), d2(r.t31a.sgst)]))
  out.push(row(['3.1(b)', 'Outward taxable supplies — zero rated', d2(r.t31b.taxable), d2(r.t31b.igst), '0.00', '0.00']))
  out.push(row(['3.1(d)', 'Inward supplies liable to reverse charge', d2(r.t31d.taxable), d2(r.t31d.igst), '0.00', '0.00']))
  out.push('')
  out.push(row(['4(A)', 'ITC available', '', d2(r.t4a.igst), d2(r.t4a.cgst), d2(r.t4a.sgst)]))
  out.push(row(['4(A)(3)', 'ITC on reverse charge', '', d2(r.t4a.rcm), '0.00', '0.00']))
  out.push(row(['4(C)', 'Net ITC available', '', d2(r.t4c), '', '']))
  out.push('')
  out.push(row(['6.1', 'Payable through ITC', '', d2(r.payable.throughItc), '', '']))
  out.push(row(['6.1', 'Payable in cash', '', d2(r.payable.inCash), '', '']))
  out.push(row(['6.1', 'Reverse charge — payable in cash only', '', d2(r.payable.rcmInCash), '', '']))

  if (r.notes.length) {
    out.push('', '# notes')
    for (const n of r.notes) out.push(row([n]))
  }
  return out.join('\n') + '\n'
}
