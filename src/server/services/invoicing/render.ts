import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, formatINR, amountInWords } from '@/lib/money'
import { NotFound } from '@/server/errors'
import { placeOfSupplyLabel } from '@/server/services/tax/tax-mode'
import { sacSummary, type ComputedLine } from '@/server/services/tax/gst'

const TEMPLATE = join(process.cwd(), 'templates', 'invoice', 'tax-invoice.html')

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function addressHtml(a: unknown): string {
  const o = (a ?? {}) as Record<string, string>
  return [o.line1, o.line2, [o.city, o.state, o.pincode].filter(Boolean).join(', '), o.country]
    .filter(Boolean).map(esc).join('<br>')
}

/**
 * Renders templates/invoice/tax-invoice.html with real data.
 *
 * The template drives everything from two classes on .sheet — the tax mode and the
 * TDS mode — so the same file produces the intra-state, inter-state and export
 * documents without branching here.
 */
export async function renderInvoiceHtml(companyId: string, invoiceId: string): Promise<string> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: {
      customer: true, project: true, lines: { orderBy: { position: 'asc' } },
      financialYear: true, lut: true,
      company: { include: { bankAccounts: { where: { showOnInvoice: true }, take: 1 } } },
    },
  })
  if (!inv) throw new NotFound('Invoice not found')

  const co = inv.company
  const bank = co.bankAccounts[0]
  const isExport = inv.taxMode === 'EXPORT'

  // 🔴 Render the bill-to details AS ISSUED where we have them.
  //
  // A sent invoice carries its own snapshot; only a draft falls back to the live customer
  // row, because nothing has been issued yet. Without this, correcting a typo in a customer's
  // address would silently change every invoice already sent to them — the copy we can
  // reproduce would no longer match the copy they hold, which is precisely the defect found
  // in Adpedia's own historical invoices (docs/03).
  const billTo = {
    name: inv.billToName ?? inv.customer.name,
    address: inv.billToAddress ?? inv.customer.billingAddress,
    gstin: inv.billToGstin ?? inv.customer.gstin,
    stateCode: inv.billToStateCode ?? inv.customer.stateCode,
    country: inv.billToCountry ?? inv.customer.country,
  }
  const cur = inv.currency
  const money = (v: unknown) => (cur === 'INR' ? formatINR(v as string, { symbol: false }) : Number(v).toFixed(2))

  // the template's mode classes
  const taxClass = isExport ? 'mode-export' : inv.taxMode === 'INTER' ? 'mode-inter' : 'mode-intra'
  const tdsClass = inv.tdsSection === '194J' ? 'tds-194j' : inv.tdsSection === '194C' ? 'tds-194c' : 'tds-none'
  const sacClass = co.showSacOnInvoice ? '' : ' hide-sac'
  const lutClass = isExport && !inv.lut ? ' lut-expired' : ''

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

  const rows = inv.lines.map((l, i) => `
      <tr>
        <td class="mid">${i + 1}</td>
        <td>
          <div class="desc">${esc(l.description)}</div>
          ${l.detail ? `<div class="sub">${esc(l.detail)}</div>` : ''}
        </td>
        <td class="mid c-sac">${esc(l.sacCode ?? '—')}</td>
        <td class="mid">${Number(l.quantity)}</td>
        <td class="num">${money(l.rate.toString())}</td>
        <td class="num">${money(l.taxableValue.toString())}</td>
      </tr>`).join('')

  const computed = inv.lines.map((l) => ({
    sacCode: l.sacCode, taxableValue: new Decimal(l.taxableValue.toString()),
    cgst: new Decimal(l.cgst.toString()), sgst: new Decimal(l.sgst.toString()), igst: new Decimal(l.igst.toString()),
    total: new Decimal(l.taxableValue.toString()).plus(l.cgst.toString()).plus(l.sgst.toString()).plus(l.igst.toString()),
  })) as unknown as ComputedLine[]

  const sacRows = sacSummary(computed).map((s) => `
            <tr>
              <td>${esc(s.sacCode)}</td><td class="num">${money(s.taxableValue.toFixed(2))}</td>
              <td class="num c-cgst">${money(s.cgst.toFixed(2))}</td>
              <td class="num c-sgst">${money(s.sgst.toFixed(2))}</td>
              <td class="num c-igst">${money(s.igst.toFixed(2))}</td>
              <td class="num">${money(s.total.toFixed(2))}</td>
            </tr>`).join('')

  const SUBS: [RegExp, string][] = [
    [/class="sheet mode-intra tds-194j hide-sac"/, `class="sheet ${taxClass} ${tdsClass}${sacClass}${lutClass}"`],
    [/(<div class="v" data-bind="invoice\.number">)[^<]*/, `$1${esc(inv.number)}`],
    [/(<div class="v" data-bind="invoice\.date">)[^<]*/, `$1${fmtDate(inv.date)}`],
    [/(<div class="v" data-bind="invoice\.dueDate">)[^<]*/, `$1${fmtDate(inv.dueDate)}`],
    [/(<div class="v" data-bind="invoice\.placeOfSupply">)[^<]*/, `$1${esc(placeOfSupplyLabel(inv.taxMode, billTo.stateCode))}`],

    [/(<div class="name" data-bind="company\.legalName">)[^<]*/, `$1${esc(co.legalName)}`],
    [/(<address data-bind="company\.registeredAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(co.registeredAddress)}$2`],
    [/(<b data-bind="company\.gstin">)[^<]*/, `$1${esc(co.gstin)}`],
    [/(<b data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],
    [/(<b data-bind="company\.cin">)[^<]*/, `$1${esc(co.cin)}`],

    [/(<div class="name" data-bind="customer\.name">)[^<]*/, `$1${esc(billTo.name)}`],
    [/(<address data-bind="customer\.billingAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(billTo.address)}$2`],
    [/(<b data-bind="customer\.gstinOrNA">)[^<]*/, `$1${isExport ? 'Not applicable — overseas recipient' : esc(billTo.gstin ?? '—')}`],
    [/(<b data-bind="customer\.stateLabel">)[^<]*/, `$1${esc(isExport ? billTo.country : placeOfSupplyLabel(inv.taxMode, billTo.stateCode))}`],

    [/(<b data-bind="project\.name">)[^<]*/, `$1${esc(inv.project?.name ?? '—')}`],
    [/(<b data-bind="invoice\.customerRef">)[^<]*/, `$1${esc(inv.customerRef ?? '—')}`],
    [/(<b data-bind="invoice\.milestone">)[^<]*/, `$1${esc(inv.milestone ?? '—')}`],

    [/(<tbody>)[\s\S]*?(<\/tbody>\s*<\/table>\s*<section class="foot-grid">)/, `$1${rows}\n    $2`],
    [/(<tbody data-bind="invoice\.sacSummary">)[\s\S]*?(<\/tbody>)/, `$1${sacRows}$2`],

    [/(<p data-bind="invoice\.totalInWords">)[^<]*/, `$1${esc(amountInWords(inv.grandTotal.toString(), cur === 'INR' ? 'Indian Rupees' : 'US Dollars'))}`],
    [/(<span data-bind="invoice\.taxableValue">)[^<]*/, `$1${money(inv.taxableValue.toString())}`],
    [/(<span data-bind="invoice\.cgst">)[^<]*/, `$1${money(inv.cgst.toString())}`],
    [/(<span data-bind="invoice\.sgst">)[^<]*/, `$1${money(inv.sgst.toString())}`],
    [/(<span data-bind="invoice\.igst">)[^<]*/, `$1${money(inv.igst.toString())}`],
    [/(<span data-bind="invoice\.roundOff">)[^<]*/, `$1${money(inv.roundOff.toString())}`],
    [/(<span class="v" data-bind="invoice\.grandTotal">)[^<]*/, `$1${cur === 'INR' ? '₹ ' + money(inv.grandTotal.toString()) : cur + ' ' + money(inv.grandTotal.toString())}`],
    [/(<span data-bind="invoice\.tdsAmount">)[^<]*/, `$1(${money(inv.tdsAmount.toString())})`],
    [/(<span data-bind="invoice\.netPayable">)[^<]*/, `$1${cur === 'INR' ? '₹ ' + money(inv.netPayable.toString()) : cur + ' ' + money(inv.netPayable.toString())}`],

    [/(<dd data-bind="bank\.accountName">)[^<]*/, `$1${esc(bank?.accountName ?? '—')}`],
    [/(<dd data-bind="bank\.accountNo">)[^<]*/, `$1${esc(bank?.accountNo ?? '—')}`],
    [/(<dd data-bind="bank\.ifsc">)[^<]*/, `$1${esc(bank?.ifsc ?? '—')}`],
    [/(<dd data-bind="bank\.bankBranch">)[^<]*/, `$1${esc([bank?.bankName, bank?.branch].filter(Boolean).join(', '))}`],

    [/(<span data-bind="company\.lut\.arn">)[^<]*/, `$1${esc(inv.lut?.arn ?? '—')}`],
    [/(<span data-bind="company\.lut\.filedOn">)[^<]*/, `$1${inv.lut?.filedOn ? fmtDate(inv.lut.filedOn) : '—'}`],
    [/(<span data-bind="company\.lut\.fy">)[^<]*/, `$1FY ${esc(inv.lut?.fyLabel ?? inv.financialYear.label)}`],

    [/(<div class="copy-mark" data-bind="doc\.copyType">)[^<]*/, `$1${inv.status === 'DRAFT' ? 'Draft — not issued' : 'Original for Recipient'}`],
  ]

  let html = await readFile(TEMPLATE, 'utf8')
  for (const [re, to] of SUBS) html = html.replace(re, to)

  // 🔴 The money columns must carry the invoice's OWN currency.
  //
  // The template hard-codes "(₹)". On a USD export invoice that produces a document whose
  // header says rupees and whose total says USD — contradictory on its face, and the kind
  // of thing a client's bank queries before releasing an inward remittance.
  const curLabel = cur === 'INR' ? '₹' : cur
  html = html.replace(/Rate \(₹\)/g, `Rate (${curLabel})`)
             .replace(/Taxable Value \(₹\)/g, `Taxable Value (${curLabel})`)

  // 🔴 The payment term is stated on the invoice, so it has to BE the invoice's term.
  // The template said "within 15 days" regardless; this customer is on 30-day terms, so the
  // sentence contradicted the due date printed two inches above it.
  const termDays = Math.max(
    0, Math.round((inv.dueDate.getTime() - inv.date.getTime()) / 86_400_000),
  )
  html = html.replace(
    /Payment due within 15 days of the invoice date\./g,
    `Payment due within ${termDays} day${termDays === 1 ? '' : 's'} of the invoice date.`,
  )

  // 🔴 Brand assets are INLINED as data URIs, not linked.
  //
  // A root-relative "/brand/…" resolves correctly when this HTML is served over HTTP, and
  // silently fails when Chromium renders it through setContent() for the PDF — there is no
  // base URL to resolve against, so the logo and the signature just do not appear. Nothing
  // errors; the invoice is simply issued unbranded and unsigned, and the first anyone knows
  // is a client receiving it.
  //
  // Inlining also makes the document self-contained: no network at render time, and the
  // same bytes whether it is printed from the browser, emailed or shared over WhatsApp.
  const [logo, signature] = await Promise.all([
    dataUri('adpedia-logo.svg', 'image/svg+xml'),
    dataUri('signature.png', 'image/png'),
  ])
  html = html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)
             .replace(/src="assets\/signature\.png"/g, `src="${signature}"`)
  return html
}

const BRAND_DIR = join(process.cwd(), 'public', 'brand')

/** Read a brand asset as a data URI, or '' if it is missing — a missing logo must not
 *  take the whole invoice down. */
async function dataUri(file: string, mime: string): Promise<string> {
  try {
    const bytes = await readFile(join(BRAND_DIR, file))
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
