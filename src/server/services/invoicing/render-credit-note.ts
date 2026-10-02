import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, formatINR, amountInWords } from '@/lib/money'
import { NotFound } from '@/server/errors'
import { placeOfSupplyLabel } from '@/server/services/tax/tax-mode'
import { gstAdjustmentDeadline } from './credit-note'

const TEMPLATE = join(process.cwd(), 'templates', 'credit-note', 'credit-note.html')
const BRAND_DIR = join(process.cwd(), 'public', 'brand')

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function addressHtml(a: unknown): string {
  const o = (a ?? {}) as Record<string, string>
  return [o.line1, o.line2, [o.city, o.state, o.pincode].filter(Boolean).join(', '), o.country]
    .filter(Boolean).map(esc).join('<br>')
}

/**
 * The credit note as a document — docs/48.
 *
 * Rule 53(1A) fixes what has to be on it, and the two fields people forget are the ones the
 * recipient needs most: **the number and date of the invoice it relates to**. Without them a
 * credit note is a payment the client's accounts team cannot allocate.
 *
 * 🔴 The recipient's details come from the INVOICE'S OWN SNAPSHOT, not from the customer
 * record. The invoice froze them when it was sent (docs/41); a credit note that re-read the
 * live customer would show today's address against yesterday's supply, and the pair that is
 * supposed to net out would not agree on who it was issued to.
 */
export async function renderCreditNoteHtml(companyId: string, creditNoteId: string): Promise<string> {
  // CreditNote carries companyId without a relation, so the company is read alongside it
  const [note, co] = await Promise.all([
    prisma.creditNote.findFirst({
      where: { id: creditNoteId, companyId },
      include: {
        invoice: { include: { customer: true, project: true, lines: { orderBy: { position: 'asc' } } } },
      },
    }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  ])
  if (!note) throw new NotFound('Credit note not found')
  const inv = note.invoice
  const cur = inv?.currency ?? 'INR'
  const taxMode = inv?.taxMode ?? 'INTRA'
  const isExport = taxMode === 'EXPORT'

  const billTo = {
    name: inv?.billToName ?? inv?.customer.name ?? '—',
    address: inv?.billToAddress ?? inv?.customer.billingAddress ?? {},
    gstin: inv?.billToGstin ?? inv?.customer.gstin ?? null,
    stateCode: inv?.billToStateCode ?? inv?.customer.stateCode ?? null,
    country: inv?.billToCountry ?? inv?.customer.country ?? 'IN',
  }

  // 🔴 The invoice's currency, not rupees. Same trap the invoice template had: a USD export
  // credited in a document headed "(₹)" is a figure a client's bank will query.
  const money = (v: unknown) => (cur === 'INR' ? formatINR(v as string, { symbol: false }) : Number(v).toFixed(2))
  const withSymbol = (v: unknown) => (cur === 'INR' ? `₹ ${money(v)}` : `${cur} ${money(v)}`)

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

  /**
   * 🔴 Day markers are formatted in UTC, not in IST.
   *
   * An invoice date is midnight UTC, so IST reads it as 05:30 the same day and nothing moves.
   * A DEADLINE is the other end of the day — `30 Nov 23:59:59 UTC` — and IST pushes it to
   * 05:29 on 1 December. The document then told the client the s.34(2) limit was 1 December
   * when the statute says 30 November, on the one line where being a day out is the whole
   * point of the sentence.
   */
  const fmtDay = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

  const taxable = new Decimal(note.taxableValue.toString())
  const cgst = new Decimal(note.cgst.toString())
  const sgst = new Decimal(note.sgst.toString())
  const igst = new Decimal(note.igst.toString())
  const notAdjusted = new Decimal(note.taxNotAdjusted.toString())

  /** The rate as it was charged, derived from the amounts rather than today's table. */
  const ratePct = (part: Decimal) =>
    taxable.gt(0) && part.gt(0) ? `@ ${part.div(taxable).mul(100).toDecimalPlaces(2).toString()}%` : ''

  // A credit note has no lines of its own; the SAC is only unambiguous when the whole
  // invoice carried one. Where it did not, the column is dropped rather than guessed at.
  const sacs = new Set((inv?.lines ?? []).map((l) => l.sacCode).filter(Boolean) as string[])
  const sac = sacs.size === 1 ? [...sacs][0] : null

  const taxClass = isExport ? 'mode-export' : taxMode === 'INTER' ? 'mode-inter' : 'mode-intra'
  const gstClass = note.gstAdjusted ? 'gst-adjusted' : 'gst-commercial'
  const sacClass = sac ? '' : ' hide-sac'

  const reportingNote = note.gstAdjusted
    ? 'This note is reported in table 9B (credit notes) of GSTR-1 for the period in which it is issued.'
    : 'This note is NOT reported in GSTR-1: no output tax is being adjusted against it.'

  const effect = inv
    ? `The amount payable against invoice ${esc(inv.number)} is reduced by the total above. The invoice itself ` +
      'stands as issued and remains reported; this note is a separate document with its own number, reported separately.'
    : 'The amount payable is reduced by the total above.'

  const SUBS: [RegExp, string][] = [
    [/class="sheet mode-intra gst-adjusted"/, `class="sheet ${taxClass} ${gstClass}${sacClass}"`],

    [/(<div class="v" data-bind="note\.number">)[^<]*/, `$1${esc(note.number)}`],
    [/(<div class="v" data-bind="note\.date">)[^<]*/, `$1${fmtDate(note.date)}`],
    // 🔴 Bound in TWO places — the meta strip and the s.34(2) declaration. Replacing only
    // the first left the warning paragraph quoting the template's placeholder invoice
    // number, so a document correctly headed against ADP/26-27/0031 declared, in its one
    // legally-loaded sentence, that the deadline had passed for a different invoice.
    [/(data-bind="invoice\.number">)[^<]*/g, `$1${esc(inv?.number ?? '—')}`],
    [/(<div class="v" data-bind="invoice\.date">)[^<]*/, `$1${inv ? fmtDate(inv.date) : '—'}`],

    // bound twice as well — the supplier block and the signature line
    [/(data-bind="company\.legalName">)[^<]*/g, `$1${esc(co.legalName)}`],
    [/(<address data-bind="company\.registeredAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(co.registeredAddress)}$2`],
    [/(<b data-bind="company\.gstin">)[^<]*/, `$1${esc(co.gstin)}`],
    [/(<b data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],
    [/(<b data-bind="company\.cin">)[^<]*/, `$1${esc(co.cin)}`],

    [/(<div class="name" data-bind="customer\.name">)[^<]*/, `$1${esc(billTo.name)}`],
    [/(<address data-bind="customer\.billingAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(billTo.address)}$2`],
    [/(<b data-bind="customer\.gstinOrNA">)[^<]*/, `$1${isExport ? 'Not applicable — overseas recipient' : esc(billTo.gstin ?? '—')}`],
    [/(<b data-bind="customer\.stateLabel">)[^<]*/, `$1${esc(isExport ? billTo.country : placeOfSupplyLabel(taxMode, billTo.stateCode))}`],

    [/(<b data-bind="project\.name">)[^<]*/, `$1${esc(inv?.project?.name ?? '—')}`],
    [/(<b data-bind="invoice\.customerRef">)[^<]*/, `$1${esc(inv?.customerRef ?? '—')}`],

    [/(<div class="desc" data-bind="note\.description">)[^<]*/,
      `$1Credit against tax invoice ${esc(inv?.number ?? '—')}${inv ? ` dated ${fmtDate(inv.date)}` : ''}`],
    [/(<td class="mid c-sac" data-bind="note\.sac">)[^<]*/, `$1${esc(sac ?? '—')}`],

    [/(<p data-bind="note\.reasonFull">)[^<]*/, `$1${esc(note.reason)}`],
    [/(<p data-bind="note\.totalInWords">)[^<]*/,
      `$1${esc(amountInWords(note.grandTotal.toString(), cur === 'INR' ? 'Indian Rupees' : 'US Dollars'))}`],

    [/(<span data-bind="note\.cgstRate">)[^<]*/, `$1${ratePct(cgst)}`],
    [/(<span data-bind="note\.sgstRate">)[^<]*/, `$1${ratePct(sgst)}`],
    [/(<span data-bind="note\.igstRate">)[^<]*/, `$1${ratePct(igst)}`],
    [/(<span data-bind="note\.cgst">)[^<]*/, `$1${money(cgst.toFixed(2))}`],
    [/(<span data-bind="note\.sgst">)[^<]*/, `$1${money(sgst.toFixed(2))}`],
    [/(<span data-bind="note\.igst">)[^<]*/, `$1${money(igst.toFixed(2))}`],
    [/(<span data-bind="note\.taxNotAdjusted">)[^<]*/, `$1${money(notAdjusted.toFixed(2))}`],
    [/(<span class="v" data-bind="note\.grandTotal">)[^<]*/, `$1${withSymbol(note.grandTotal.toString())}`],

    [/(<p data-bind="note\.effect">)[\s\S]*?(<\/p>)/, `$1${effect}$2`],
    [/(<span data-bind="note\.reportingNote">)[^<]*/, `$1${esc(reportingNote)}`],
    [/(<span data-bind="note\.deadline">)[^<]*/, `$1${inv ? fmtDay(gstAdjustmentDeadline(inv.date)) : '—'}`],
  ]

  let html = await readFile(TEMPLATE, 'utf8')
  for (const [re, to] of SUBS) html = html.replace(re, to)

  // the taxable-value cell is bound twice — once in the line, once in the totals
  html = html.replace(/(data-bind="note\.taxableValue">)[^<]*/g, `$1${money(taxable.toFixed(2))}`)

  // the column heading carries the currency, like the invoice's does
  html = html.replace(/Value Credited \(₹\)/g, `Value Credited (${cur === 'INR' ? '₹' : cur})`)

  // 🔴 Inlined, not linked — docs/33. Chromium renders this through setContent() with no
  // base URL, so a relative asset silently does not appear and the note goes out unbranded
  // and unsigned.
  const [logo, signature] = await Promise.all([
    dataUri('adpedia-logo.svg', 'image/svg+xml'),
    dataUri('signature.png', 'image/png'),
  ])
  html = html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)
             .replace(/src="assets\/signature\.png"/g, `src="${signature}"`)

  // the SAC column is dropped when the invoice did not carry a single unambiguous code
  if (!sac) {
    html = html.replace(/<th class="mid c-sac"[^>]*>SAC<\/th>/, '')
               .replace(/<td class="mid c-sac"[^>]*>[^<]*<\/td>/, '')
  }
  return html
}

async function dataUri(file: string, mime: string): Promise<string> {
  try {
    const bytes = await readFile(join(BRAND_DIR, file))
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
