import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, formatINR, amountInWords } from '@/lib/money'
import { NotFound } from '@/server/errors'
import { placeOfSupplyLabel, resolveTaxMode } from '@/server/services/tax/tax-mode'

const TEMPLATE = join(process.cwd(), 'templates', 'voucher', 'voucher.html')
const BRAND_DIR = join(process.cwd(), 'public', 'brand')

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function addressHtml(a: unknown): string {
  const o = (a ?? {}) as Record<string, string>
  return [o.line1, o.line2, [o.city, o.state, o.pincode].filter(Boolean).join(', '), o.country]
    .filter(Boolean).map(esc).join('<br>')
}

const money = (v: Decimal.Value) => formatINR(v, { symbol: false })
const day = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

export type VoucherKind = 'receipt' | 'refund'

/**
 * 🔴 `NEFT`, not `neft`.
 *
 * The enum is upper case and lower-casing it for display printed "neft" on a document going
 * to a client — four of the nine modes are acronyms and read as a typo in lower case, while
 * the rest read as shouting in upper. A map is three lines and settles it.
 */
const MODE_LABEL: Record<string, string> = {
  NEFT: 'NEFT', RTGS: 'RTGS', IMPS: 'IMPS', UPI: 'UPI', SWIFT: 'SWIFT',
  CHEQUE: 'Cheque', CASH: 'Cash', CARD: 'Card', OTHER: 'Other',
}

/**
 * The two advance vouchers — docs/65.
 *
 * 🔴 One template, because rule 49 and rule 51 prescribe nearly the same document. What
 * actually differs is the direction of the money and one field: rule 51(c) requires the
 * **number and date of the receipt voucher** being refunded against, and without it the
 * recipient cannot tie the two together — nor can anybody reading table 11B.
 *
 * This is the same reasoning as docs/48, where one template served credit and debit notes.
 */
export async function renderVoucherHtml(
  companyId: string, kind: VoucherKind, id: string,
): Promise<string> {
  const co = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })

  const refund = kind === 'refund'
    ? await prisma.refundVoucher.findFirst({
        where: { id, companyId },
        include: { customer: true, receipt: { select: { number: true, date: true, mode: true } } },
      })
    : null
  if (kind === 'refund' && !refund) throw new NotFound('Refund voucher not found')

  const receipt = kind === 'receipt'
    ? await prisma.receipt.findFirst({ where: { id, companyId, isAdvance: true }, include: { customer: true } })
    : null
  if (kind === 'receipt' && !receipt) throw new NotFound('Advance not found')

  const customer = (refund?.customer ?? receipt!.customer)
  const mode = await resolveTaxMode(co, customer)

  // the receipt voucher's own split is re-derived from the posting that created it
  const tax = refund
    ? {
        cgst: new Decimal(refund.cgst.toString()),
        sgst: new Decimal(refund.sgst.toString()),
        igst: new Decimal(refund.igst.toString()),
        taxable: new Decimal(refund.taxableValue.toString()),
        gross: new Decimal(refund.amount.toString()),
      }
    : await receiptSplit(companyId, receipt!.id)

  const number = refund?.number ?? receipt!.number
  const date = refund?.date ?? receipt!.date
  const taxMode = mode === 'EXPORT' ? 'INTER' : mode
  const ratePct = (part: Decimal) =>
    tax.taxable.gt(0) && part.gt(0)
      ? `@ ${part.div(tax.taxable).mul(100).toDecimalPlaces(2).toString()}%`
      : ''

  const SUBS: [RegExp, string][] = [
    [/class="sheet v-receipt mode-intra"/, `class="sheet ${refund ? 'v-refund' : 'v-receipt'} mode-${taxMode.toLowerCase()}"`],
    [/(<title>)[^<]*/, `$1${refund ? 'Refund Voucher' : 'Receipt Voucher'} — ${esc(co.legalName)}`],
    [/(<h1 data-bind="voucher\.title">)[^<]*/, `$1${refund ? 'Refund Voucher' : 'Receipt Voucher'}`],
    [/(<div class="copy-mark" data-bind="voucher\.statute">)[^<]*/,
      `$1${refund ? 'Section 31(3)(e) &middot; Rule 51' : 'Section 31(3)(d) &middot; Rule 49'}`],

    [/(<div class="v" data-bind="voucher\.number">)[^<]*/, `$1${esc(number)}`],
    [/(<div class="v" data-bind="voucher\.date">)[^<]*/, `$1${day(date)}`],
    [/(<div class="v" data-bind="voucher\.placeOfSupply">)[^<]*/,
      `$1${esc(placeOfSupplyLabel(mode, customer.stateCode))}`],
    /**
     * 🔴 The fourth cell carries ONE thing.
     *
     * The first version stacked rule 51(c)'s receipt-voucher reference above the payment
     * mode in the same cell, and on paper it came out as two labels and two values crammed
     * into a quarter of the strip, wrapping onto four lines. A refund's cell is the
     * reference, because that is the field the rule requires; a receipt's is the mode.
     */
    [/(<div class="k only-refund">)[^<]*/, `$1Against Receipt Voucher`],
    [/(<div class="v only-refund" data-bind="voucher\.againstReceipt">)[^<]*/,
      `$1${esc(refund ? `${refund.receipt.number} · ${day(refund.receipt.date)}` : '—')}`],
    [/(<div class="k" data-bind="voucher\.modeLabel">)[^<]*/, `$1Received By`],
    [/(<div class="v" data-bind="voucher\.mode">)[^<]*/,
      `$1${esc(MODE_LABEL[(receipt?.mode ?? refund?.receipt.mode) as string] ?? 'Other')}`],

    [/(<div class="name" data-bind="company\.legalName">)[^<]*/, `$1${esc(co.legalName)}`],
    [/(<address data-bind="company\.registeredAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(co.registeredAddress)}$2`],
    [/(<b data-bind="company\.gstin">)[^<]*/, `$1${esc(co.gstin)}`],
    [/(<b data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],

    [/(<h2 data-bind="voucher\.partyHeading">)[^<]*/, `$1${refund ? 'Refunded To' : 'Received From'}`],
    [/(<div class="name" data-bind="customer\.name">)[^<]*/, `$1${esc(customer.name)}`],
    [/(<address data-bind="customer\.billingAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(customer.billingAddress)}$2`],
    [/(<b data-bind="customer\.gstinOrNA">)[^<]*/, `$1${esc(customer.gstin ?? 'Unregistered')}`],

    [/(<th class="num" data-bind="voucher\.amountHeading">)[^<]*/, `$1Amount (&#8377;)`],
    [/(<div class="desc" data-bind="voucher\.description">)[^<]*/,
      `$1${refund ? 'Advance returned — no supply made' : 'Advance against services to be supplied'}`],
    [/(<div class="sub" data-bind="voucher\.subDescription">)[^<]*/,
      `$1${refund
        ? 'The tax declared when this advance was received is adjusted in the return for this period'
        : 'Tax charged under section 13(2) — the time of supply is the date of receipt'}`],

    [/(<h3 data-bind="voucher\.wordsHeading">)[^<]*/, `$1Total ${refund ? 'refunded' : 'received'} (in words)`],
    [/(<p data-bind="voucher\.totalInWords">)[^<]*/, `$1${esc(amountInWords(tax.gross.toFixed(2)))}`],
    [/(<h3 data-bind="voucher\.reasonHeading">)[^<]*/, `$1Reason for the refund`],
    [/(<p data-bind="voucher\.reason">)[^<]*/, `$1${esc(refund?.reason ?? '')}`],

    [/(<span class="k" data-bind="voucher\.taxableLabel">)[^<]*/, `$1Value ${refund ? 'refunded' : 'of supply'}`],
    [/(<span data-bind="voucher\.cgstRate">)[^<]*/, `$1${ratePct(tax.cgst)}`],
    [/(<span data-bind="voucher\.sgstRate">)[^<]*/, `$1${ratePct(tax.sgst)}`],
    [/(<span data-bind="voucher\.igstRate">)[^<]*/, `$1${ratePct(tax.igst)}`],
    [/(<span data-bind="voucher\.cgst">)[^<]*/, `$1${money(tax.cgst.toFixed(2))}`],
    [/(<span data-bind="voucher\.sgst">)[^<]*/, `$1${money(tax.sgst.toFixed(2))}`],
    [/(<span data-bind="voucher\.igst">)[^<]*/, `$1${money(tax.igst.toFixed(2))}`],
    [/(<span class="k" data-bind="voucher\.grandLabel">)[^<]*/, `$1Total ${refund ? 'Refunded' : 'Received'}`],
    [/(<span class="v" data-bind="voucher\.grandTotal">)[^<]*/, `$1&#8377; ${money(tax.gross.toFixed(2))}`],

    [/(<h3 data-bind="voucher\.effectHeading">)[^<]*/, `$1What this voucher does`],
    [/(<p data-bind="voucher\.effect">)[\s\S]*?(<\/p>)/, `$1${refund
      ? 'No supply was made against this advance, so no tax invoice will follow it. The tax charged when ' +
        'the money was received is adjusted in the return for the period of this voucher — this is not a ' +
        'credit note, and it does not affect any invoice.'
      : 'This is not a tax invoice. A tax invoice will be issued when the supply is made, and the tax shown ' +
        'above will be adjusted against it.'}$2`],
    [/(<div class="for" data-bind="company\.forLine">)[^<]*/, `$1For ${esc(co.legalName)}`],

    [/(<ol data-bind="voucher\.declarations">)[\s\S]*?(<\/ol>)/, `$1${refund
      ? '<li>Issued under section 31(3)(e) of the CGST Act 2017 and Rule 51 of the CGST Rules.</li>' +
        '<li>This voucher refunds the receipt voucher identified above. No supply was made against it.</li>' +
        '<li>This is not a credit note: section 34 applies to an invoice, and no invoice was issued.</li>'
      : '<li>Issued under section 31(3)(d) of the CGST Act 2017 and Rule 49 of the CGST Rules.</li>' +
        '<li>Tax is charged on this advance under section 13(2). The relief in Notification 66/2017 applies ' +
        'to goods only, not to services.</li>' +
        '<li>Where the rate or the place of supply is not determinable, Rule 50 applies — 18%, and ' +
        'inter-State respectively.</li>'}$2`],
    [/(<div class="ids" data-bind="company\.footerIds">)[\s\S]*?(<\/div>)/,
      `$1${esc(co.legalName)}${co.gstin ? ` &middot; GSTIN ${esc(co.gstin)}` : ''}$2`],
  ]

  let html = await readFile(TEMPLATE, 'utf8')
  for (const [re, to] of SUBS) html = html.replace(re, to)

  // 🔴 a receipt voucher has no "reason" distinct from its own description, and the first
  // version repeated the line verbatim under a second heading reading "Particulars" — the
  // same word as the table header directly above it. The block is dropped instead.
  if (!refund) {
    html = html.replace(/<div class="why">[\s\S]*?<\/div>/, '')
  }

  // 🔴 bound twice — in the line and in the totals block — so a global replace, docs/48 §3
  html = html.replace(/(data-bind="voucher\.taxableValue2?">)[^<]*/g, `$1${money(tax.taxable.toFixed(2))}`)

  // inlined, not linked — docs/33. setContent() has no base URL.
  const [logo, signature] = await Promise.all([
    dataUri('adpedia-logo.svg', 'image/svg+xml'),
    dataUri('signature.png', 'image/png'),
  ])
  html = html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)
             .replace(/src="assets\/signature\.png"/g, `src="${signature}"`)
  return html
}

/** The receipt voucher's own split, read back from the journal that created it. */
async function receiptSplit(companyId: string, receiptId: string) {
  const entry = await prisma.journalEntry.findFirst({
    where: { companyId, sourceType: 'RECEIPT', sourceId: receiptId, narration: { contains: 'Advance from' } },
    include: { lines: { include: { account: true } } },
    orderBy: { date: 'asc' },
  })
  const credit = (code: string) =>
    new Decimal(
      (entry?.lines ?? []).filter((l) => l.account.code === code)
        .reduce((a, l) => a + Number(l.credit), 0).toFixed(2),
    )
  const taxable = credit('2400')
  const cgst = credit('2110'), sgst = credit('2120'), igst = credit('2130')
  return { taxable, cgst, sgst, igst, gross: taxable.plus(cgst).plus(sgst).plus(igst) }
}

async function dataUri(file: string, mime: string): Promise<string> {
  try {
    const bytes = await readFile(join(BRAND_DIR, file))
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
