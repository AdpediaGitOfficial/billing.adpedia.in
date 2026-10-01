# 33 · The PDF renderer

**Status: done.** 386 tests (223 unit + 163 integration), typecheck and lint clean,
production build passes.

Deferred since phase 1. `/api/invoices/[id]/document` now returns a real **PDF**;
`?format=html` returns the same document as HTML, which is what the render tests assert
against and what makes a layout problem debuggable in a browser.

---

## 1. One browser, many pages

```ts
let browserPromise: Promise<Browser> | null = null
```

🔴 Chromium is launched **once** and reused. A cold launch is roughly a second — per
request that would make every invoice download feel broken, and under any concurrency it
would fork a browser per request until the box ran out of memory.

The *page* is per-render and always closed, because a page holds the document's DOM and
leaking one leaks the customer's details with it. Two further guards:

- A failed launch is **not cached** as a rejection, so the next request retries instead of
  inheriting a permanent failure.
- If the browser dies under us — OOM kill, container restart — `isConnected()` catches it
  and relaunches, rather than failing every later render with "Target closed".

## 2. Three settings that are load-bearing

- **`waitUntil: 'domcontentloaded'`, not `networkidle`.** The template pulls a webfont from
  Google. If that host is slow or blocked, `networkidle` never settles and the request
  hangs until the timeout. The document must render with whatever it has.
- **`printBackground: true`.** The brand bar, the totals block and the table rules are all
  backgrounds. Without it the invoice prints bare.
- **`preferCSSPageSize: true`** with zero margins, because the template already defines its
  own `@page` size and padding.

### 🔴 The font wait is passed as a string

```ts
await page.evaluate('document.fonts && document.fonts.ready').catch(() => {})
```

Not an arrow function. Bundlers that keep function names — esbuild's `keepNames`, which
`tsx` enables — rewrite a transpiled closure to reference a `__name` helper that does not
exist inside the page. The call throws, the `.catch` swallows it, and **the font wait
silently never happens**: the PDF quietly renders in a fallback face and nothing reports
it. This was found by hitting the identical failure in a diagnostic script.

## 3. 🔴 Three invoice defects this uncovered

Pagination forced the layout to be measured for the first time, and measuring it found
real errors on a **Kerala (intra-state)** invoice:

| Printed | Should have been |
|---|---|
| `IGST @ 18%  0.00` | hidden — there is no IGST on an intra-state supply |
| `GST — Zero rated (export of services)  0.00` | hidden — **this is not an export** |
| `@ 10% u/s 194J` **and** `@ 2% u/s 194C` | only the section that applies |

All three are one cause: **CSS specificity**. `.totals .row { display:flex }` is `(0,2,0)`
and outranks a single-class `.r-igst { display:none }` at `(0,1,0)`, so the hide never
applied. Same for the TDS labels, where `.totals .tds .k small` at `(0,4,0)` beat
`.v-194j`.

The second row is the serious one: a domestic tax invoice stating the supply is a
zero-rated export **misdescribes the nature of the supply** on a document issued under
Rule 46.

Fixed with `!important` on the mode-visibility rules — load-bearing here, not laziness —
and a comment at each site saying why, since the next person to tidy them away would
reintroduce exactly this.

## 3b. 🔴 The logo and signature never reached the PDF

Found by rendering the PDF to an image and **looking at it** — the header and footer showed
a broken-image icon, and the signature block was empty above "Authorised Signatory".

The render service rewrote `assets/adpedia-logo.svg` to a root-relative `/brand/…`. That
resolves correctly when the HTML is served over HTTP, because the browser resolves it
against the page's origin. Under `page.setContent()` there is **no base URL**, so it
resolves against `about:blank` and fails.

🔴 Nothing errors. The invoice is simply issued **unbranded and unsigned**, and the first
anyone knows is a client receiving it.

Both assets are now inlined as **data URIs**, which also makes the document self-contained:
no network at render time, and identical bytes whether it is printed from the browser,
emailed or shared over WhatsApp. A missing file degrades to an empty `src` rather than
taking the whole invoice down.

An existing test asserted `/brand/signature.png` — it had been encoding the broken
behaviour. It now asserts the embedded form, alongside a new test that the rendered HTML
contains no linked asset at all.

## 3c. 🔴 Three more defects, found by looking at the export invoice

Rendering the export layout and reading it surfaced three errors that no existing test
covered, all on a client-facing document:

1. **Two different currency rules in one file.** `previewInvoice` billed a UAE customer in
   **AED**; `createInvoice` always wrote **USD**. The figure shown on screen before saving
   disagreed with the invoice actually issued. Both now call one `invoiceCurrency()` helper,
   backed by a new `Customer.currency` column — the billing currency is a commercial term
   **agreed with the client**, not something to infer from their country. An Indian exporter
   routinely bills a UAE client in USD.
2. **The money columns said "(₹)" on a USD invoice.** A document whose header says rupees
   and whose total says USD is contradictory on its face, and is the kind of thing a
   client's bank queries before releasing an inward remittance.
3. **"Payment due within 15 days" was hard-coded.** The export customer is on 30-day terms,
   so the sentence contradicted the due date printed two inches above it. It is now derived
   from the invoice's own date-to-due-date span.

## 4. 🔴 The invoice did not fit on a page

Measured at **405mm against A4's 297mm** — it was silently printing on two sheets, against
an explicit requirement that it be compact for A4.

Compacted to **297mm** by tightening spacing and the type scale, keeping all body text at
8pt or above:

| Block | Before | After |
|---|---|---|
| `.totals` | 103.7mm | 61.0mm |
| `.parties` | 59.5mm | 45.1mm |
| `.items` (2 lines) | 53.1mm | 37.6mm |
| `.terms` | 40.9mm | 28.2mm |
| **sheet** | **405mm** | **297mm ✓** |

Hiding the two rows that should never have shown accounted for 17mm of it.

Two tests now hold the line: the PDF must start `%PDF-`, and it must contain exactly **one**
`/Type /Page` object. A two-page tax invoice means the layout has broken and the signature
block has fallen onto a sheet of its own.

## 5. Verified by reading the output

The generated PDF was read back and checked — not just asserted on byte count:

```
pages: 1
ADP/26-27/0026 · 30 Sept 2026 · Kerala (32)
VIII/318, Chinnangath House            ← the corrected address
GSTIN 32AAUCA9985H1ZX  PAN AAUCA9985H  CIN U92190KL2021PTC068241
Taxable Value 85,000.00 · CGST @ 9% 7,650.00 · SGST @ 9% 7,650.00
INVOICE TOTAL ₹1,00,300.00
Less: TDS @ 10% u/s 194J (8,500.00) · Net Amount Payable ₹91,800.00
```

No IGST row, no zero-rated row, one TDS section. Over HTTP the route returns
`content-type: application/pdf` and `content-disposition: inline; filename="ADP-26-27-0026.pdf"`
— inline, so tapping it on a phone opens a preview rather than dumping a file in Downloads.

## 6. The WhatsApp share now sends a real PDF

Phase 9's share named the file `.pdf` while the route served HTML — a file whose extension
lied about its contents, which WhatsApp shows as a broken PDF. It now names the file from
the actual content type, so it says `.pdf` because it *is* one.

## 7. ⚠️ Deployment

Chromium is a **separate ~100MB download** from the npm package. Any machine that renders
PDFs needs it, so the deploy pipeline must run:

```bash
npx playwright install --with-deps chromium
```

`--with-deps` pulls the shared libraries Chromium needs on a bare Linux image; without them
the launch fails with a missing-library error that reads like a Playwright bug. The route is
pinned to `runtime = 'nodejs'` because Chromium cannot run on the edge.

## 8. Still open

- **Payslip PDFs** reuse `htmlToPdf` once a payslip template exists.
- **Report exports** (P&L, balance sheet) could use the same renderer.
- The PDF is generated **per request**. At Adpedia's volume that is correct — caching a tax
  document invites serving a stale one after an edit. Revisit only if it ever becomes slow.
