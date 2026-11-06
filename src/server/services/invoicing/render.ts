import { readFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { join, resolve } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, formatINR, amountInWords } from '@/lib/money'
import { countryName } from '@/lib/countries'
import { stateName } from '@/lib/indian-states'
import { currencyWords } from '@/lib/currencies'
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
/**
 * 🔴 docs/75 — which IRP sources may appear on a document.
 *
 * The mock adapter writes into the same four columns as a real one. An invoice registered
 * against it carries an IRN that is a SHA-256 of the right shape and a `signedQr` that is
 * base64 of `{"mock":true,…}` — print either and the document looks exactly like an e-invoice
 * and verifies as nothing. So the block renders only for a source this list recognises, and
 * the list is a allowlist rather than `!== 'MOCK…'`: an adapter added later and forgotten
 * would otherwise print by default.
 */
const REAL_IRP_SOURCES = new Set(['LIVE'])

export function isRealIrp(source: string | null | undefined): boolean {
  return Boolean(source && REAL_IRP_SOURCES.has(source))
}

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
  // 🔴 docs/88 — a bill of supply needs no SAC, and a personal account's lines usually have
  // none. With none on ANY line the column and the HSN summary are dropped rather than printed
  // as a column of dashes. One line with a SAC brings both back.
  const noSacAnywhere = inv.docType === 'BILL_OF_SUPPLY' && inv.lines.every((l) => !l.sacCode)
  const sacClass = co.showSacOnInvoice && !noSacAnywhere ? '' : ' hide-sac'
  const lutClass = isExport && !inv.lut ? ' lut-expired' : ''
  /**
   * 🔴 docs/82 §5 — the document an UNREGISTERED supplier issues.
   *
   * Kept as a class on the same sheet rather than a second template: docs/59's whole argument
   * is that re-rendering uses today's template, and two 469-line templates would drift from
   * each other invoice by invoice. The CSS does what the mode classes already do for tax rows.
   */
  const docClass = inv.docType === 'BILL_OF_SUPPLY' ? ' doc-bos' : ''

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

  const docLabel = inv.docType === 'BILL_OF_SUPPLY' ? 'Bill of Supply'
    : inv.docType === 'EXPORT_INVOICE' ? 'Export Invoice'
    : 'Tax Invoice'

  const SUBS: [RegExp, string][] = [
    // 🔴 the document said "Bill of Supply" in its heading and "Tax Invoice" in its title, which
    // is what a saved file, a browser tab and the PDF's own metadata report
    [/<title>[^<]*<\/title>/, `<title>${esc(`${docLabel} — ${co.legalName}`)}</title>`],
    [/class="sheet mode-intra tds-194j hide-sac"/, `class="sheet ${taxClass} ${tdsClass}${sacClass}${lutClass}${docClass}"`],
    [/(<div class="v" data-bind="invoice\.number">)[^<]*/, `$1${esc(inv.number)}`],
    [/(<div class="v" data-bind="invoice\.date">)[^<]*/, `$1${fmtDate(inv.date)}`],
    [/(<div class="v" data-bind="invoice\.dueDate">)[^<]*/, `$1${fmtDate(inv.dueDate)}`],
    [/(<div class="v" data-bind="invoice\.placeOfSupply">)[^<]*/, `$1${esc(placeOfSupplyLabel(inv.taxMode, billTo.stateCode))}`],

    // 🔴 Bound twice: the supplier block and the "For <company>" above the signature. Only
    // the first was ever substituted, so the signature line printed whatever the template
    // happened to carry. It reads correctly today because the placeholder IS this company —
    // which is exactly how a defect like this survives a careful look at the output.
    [/(data-bind="company\.legalName">)[^<]*/g, `$1${esc(co.legalName)}`],
    [/(<address data-bind="company\.registeredAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(co.registeredAddress)}$2`],
    [/(<b data-bind="company\.gstin">)[^<]*/, `$1${esc(co.gstin)}`],
    [/(<b data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],
    [/(<b data-bind="company\.cin">)[^<]*/, `$1${esc(co.cin)}`],
    /**
     * 🔴 The footer printed CIN, GSTIN and PAN as LITERAL TEXT with no bind point at all, so
     * every document of every entity carried Adpedia's three identifiers. On a bill of supply
     * from an unregistered person that means displaying somebody else's GSTIN on a document
     * whose whole point is that there is no GSTIN — found by rendering it and reading the
     * footer. Only the identifiers this entity actually has are printed.
     */
    // who signed it, and as what. Blank falls back to the generic line rather than printing a
    // name nobody entered.
    [/(<div class="line" data-bind="company\.signatoryName">)[^<]*/, `$1${esc(co.signatoryName || 'Authorised Signatory')}`],
    [/(<div class="desig" data-bind="company\.signatoryDesignation">)[^<]*/, `$1${esc(co.signatoryDesignation ?? '')}`],
    /**
     * 🔴 A bill of supply carries none of the three identifiers (rule 49, and there is no GSTIN
     * to give), which left the footer empty. What a recipient of one actually needs there is
     * how to reach the supplier about it — so the same strip carries contact details instead.
     */
    [/(<span class="ids" data-bind="company\.footerIds">)[^<]*/, `$1${esc(inv.docType === 'BILL_OF_SUPPLY' ? [
      co.email, co.phone, co.website,
    ].filter(Boolean).join('  ·  ') : [
      co.cin ? `CIN ${co.cin}` : null,
      co.gstin ? `GSTIN ${co.gstin}` : null,
      `PAN ${co.pan}`,
    ].filter(Boolean).join('  ·  '))}`],

    [/(<div class="name" data-bind="customer\.name">)[^<]*/, `$1${esc(billTo.name)}`],
    [/(<address data-bind="customer\.billingAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(billTo.address)}$2`],
    [/(<b data-bind="customer\.gstinOrNA">)[^<]*/, `$1${isExport ? 'Not applicable — overseas recipient' : esc(billTo.gstin ?? '—')}`],
    [/(<b data-bind="customer\.stateLabel">)[^<]*/, `$1${esc(isExport ? countryName(billTo.country) : placeOfSupplyLabel(inv.taxMode, billTo.stateCode))}`],

    [/(<b data-bind="project\.name">)[^<]*/, `$1${esc(inv.project?.name ?? '—')}`],
    [/(<b data-bind="invoice\.customerRef">)[^<]*/, `$1${esc(inv.customerRef ?? '—')}`],
    [/(<b data-bind="invoice\.milestone">)[^<]*/, `$1${esc(inv.milestone ?? '—')}`],

    [/(<tbody>)[\s\S]*?(<\/tbody>\s*<\/table>\s*<section class="foot-grid">)/, `$1${rows}\n    $2`],
    [/(<tbody data-bind="invoice\.sacSummary">)[\s\S]*?(<\/tbody>)/, `$1${sacRows}$2`],

    [/(<p data-bind="invoice\.totalInWords">)[^<]*/, `$1${esc(amountInWords(inv.grandTotal.toString(), currencyWords(cur)))}`],
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
    // 🔴 Unbound until docs/82 §5, so the template's own "AXISINBB" printed on EVERY document
    // of every company — telling another entity's client to remit overseas funds to Adpedia's
    // bank. Found by rendering a bill of supply for an entity with no bank account at all.
    [/(<dd data-bind="bank\.swift">)[^<]*/, `$1${esc(bank?.swift ?? '—')}`],

    [/(<span data-bind="company\.lut\.arn">)[^<]*/, `$1${esc(inv.lut?.arn ?? '—')}`],
    [/(<span data-bind="company\.lut\.filedOn">)[^<]*/, `$1${inv.lut?.filedOn ? fmtDate(inv.lut.filedOn) : '—'}`],
    [/(<span data-bind="company\.lut\.fy">)[^<]*/, `$1FY ${esc(inv.lut?.fyLabel ?? inv.financialYear.label)}`],

    [/(<div class="copy-mark" data-bind="doc\.copyType">)[^<]*/, `$1${inv.status === 'DRAFT' ? 'Draft — not issued' : 'Original for Recipient'}`],
  ]

  /**
   * 🔴 The QR is the IRP's OWN signed payload, printed verbatim.
   *
   * Rule 46(r) wants the code the portal returned. Encoding the invoice's particulars
   * ourselves would produce something that scans, looks official and was signed by nobody —
   * a forgery that nobody set out to make, and that only fails when somebody verifies it.
   */
  const eInvoice = isRealIrp(inv.irpSource) && inv.irn && inv.signedQr
    ? {
        irn: inv.irn,
        ackNo: inv.ackNo ?? '—',
        ackDate: inv.ackDate ? fmtDate(inv.ackDate) : '—',
        qr: await QRCode.toDataURL(inv.signedQr, { errorCorrectionLevel: 'M', margin: 0, width: 360 }),
      }
    : null

  if (eInvoice) {
    SUBS.push(
      [/(<b data-bind="invoice\.irn">)[^<]*/, `$1${esc(eInvoice.irn)}`],
      [/(<b data-bind="invoice\.ackNo">)[^<]*/, `$1${esc(eInvoice.ackNo)}`],
      [/(<b data-bind="invoice\.ackDate">)[^<]*/, `$1${esc(eInvoice.ackDate)}`],
      [/(<img class="einvoice-qr" src=")[^"]*/, `$1${eInvoice.qr}`],
    )
  }

  let html = await readFile(TEMPLATE, 'utf8')
  for (const [re, to] of SUBS) html = html.replace(re, to)

  /**
   * 🔴 Removed entirely, not left blank.
   *
   * Adpedia is below the ₹5 Cr threshold, so its invoices are not e-invoices at all. An empty
   * IRN box on one is a claim that it should have had an IRN — and on a MOCK-registered
   * invoice a filled one would be worse: it would look exactly like the real thing.
   */
  if (!eInvoice) {
    // 🔴 Delimited by comments rather than matched structurally. A regex that counts closing
    // tags through nested markup is one edit away from removing the signature block with it,
    // and the failure is a document that renders and is missing something.
    html = html.replace(/<!--einvoice:start-->[\s\S]*?<!--einvoice:end-->/, '')
  }

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
  /**
   * 🔴 docs/82 §5 — the entity's OWN mark, not the first company's.
   *
   * These read `adpedia-logo.svg` and `signature.png` by name, so every document of every
   * company carried Adpedia's letterhead and Adpedia's signature. `Company.logoUrl` and
   * `signatureImageUrl` existed and nothing read them — a field nothing binds, docs/67 §2's
   * class, invisible until a second entity issued its first document. Found by rendering a
   * bill of supply and looking at it: an unregistered proprietor's invoice, on Adpedia's
   * letterhead, going to that proprietor's client.
   *
   * With no logo the entity's own name takes the letterhead's place, because an unbranded
   * document is fine and somebody else's brand is not.
   */
  // 🔴 A proprietorship has no CIN, and the row printed its label with nothing after it —
  // which on a legal document reads as a particular somebody forgot to fill in.
  if (!co.cin) html = html.replace(/<span><span class="lbl">CIN<\/span>[\s\S]*?<\/b><\/span>/, '')

  /**
   * 🔴 A bill of supply carries the supplier's NAME and ADDRESS and nothing else.
   *
   * Rule 49 asks for no PAN and no CIN, and there is no GSTIN to give. They are REMOVED rather
   * than hidden with CSS, because hidden text still travels inside the PDF and whoever receives
   * it can read it straight back out. The recipient's own block is untouched — rule 49(d) wants
   * their GSTIN where they are registered.
   */
  if (inv.docType === 'BILL_OF_SUPPLY') {
    html = html.replace(/(<div class="party from">[\s\S]*?)<div class="idlist">[\s\S]*?<\/div>/, '$1')

    /**
     * 🔴 docs/88 — and none of the GST vocabulary either. A personal account's client read
     * "Place of Supply: Outside India (96 – Other Country)" — a GSTR-1 reporting bucket — and
     * "Whether tax is payable under reverse charge: No" from a person who is in no return. The
     * cell says who it was supplied to; the reverse-charge line is removed, not hidden, for the
     * same reason the identifiers above are; and an overseas client's country is not printed
     * twice, once as the address and again as a "State".
     */
    const suppliedTo = isExport ? countryName(billTo.country) : stateName(billTo.stateCode)
    html = html
      .replace(/<div class="k">Place of Supply<\/div>(<div class="v" data-bind="invoice\.placeOfSupply">)[^<]*/,
        `<div class="k">Supplied to</div>$1${esc(suppliedTo)}`)
      .replace(/<li><span class="rcm-note">[\s\S]*?<\/span><\/li>\s*/, '')
    if (isExport) {
      html = html.replace(/<span><span class="lbl">State<\/span> <b data-bind="customer\.stateLabel">[^<]*<\/b><\/span>/, '')
    }
  }

  const [logo, signature] = await Promise.all([
    brandAsset(co.logoUrl),
    brandAsset(co.signatureImageUrl),
  ])
  html = logo
    ? html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)
    // 🔴 the mark appears TWICE — the letterhead and the footer brandbar. Replacing only the
    // classed one left the other entity's logo at the foot of the page, which is how this was
    // found: the guard said "adpedia-logo" was still in the document.
    : html.replace(/<img class="logo"[^>]*>/, `<div class="logo-text">${esc(co.tradeName ?? co.legalName)}</div>`)
          .replace(/<img[^>]*src="assets\/adpedia-logo\.svg"[^>]*>/g, '')
  // the signature is an <img> inside .sign; dropping just the image leaves the "For <company>"
  // line and "Authorised Signatory" rule, which every document needs whether or not a
  // specimen signature is on file
  html = signature
    ? html.replace(/src="assets\/signature\.png"/g, `src="${signature}"`)
    : html.replace(/<img src="assets\/signature\.png"[^>]*>/g, '')
  return html
}

/** A public asset as a data URI — '' when there is none, or it cannot be read. */
async function brandAsset(url: string | null | undefined): Promise<string> {
  if (!url) return ''
  // 🔴 the path comes from company settings, so it is resolved and then checked to be inside
  // public/ — a stored "../../.env" would otherwise be inlined into a document sent to a client
  const target = resolve(join(process.cwd(), 'public'), '.' + (url.startsWith('/') ? url : `/${url}`))
  if (!target.startsWith(resolve(join(process.cwd(), 'public')))) return ''

  const mime = target.endsWith('.svg') ? 'image/svg+xml'
    : target.endsWith('.png') ? 'image/png'
    : /\.jpe?g$/.test(target) ? 'image/jpeg'
    : target.endsWith('.webp') ? 'image/webp'
    : ''
  if (!mime) return ''

  try {
    const bytes = await readFile(target)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}


