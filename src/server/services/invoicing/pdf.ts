// Static import: the module only loads where it is used (the document route), and a
// dynamic one breaks under bundlers that compile to a data: URL with no base to resolve
// against. Chromium itself is still launched lazily, on the first render.
import { chromium, type Browser, type Page } from 'playwright'

/**
 * HTML → PDF via headless Chromium.
 *
 * 🔴 The browser is launched ONCE and reused. A cold launch is roughly a second — doing it
 * per request would make every invoice download feel broken, and under any concurrency it
 * would fork a browser per request until the box ran out of memory. One instance, many
 * short-lived pages.
 *
 * The page, by contrast, is created and closed per render: a page holds the document's DOM
 * and leaking one leaks the whole invoice, including the customer's details.
 */

let browserPromise: Promise<Browser> | null = null

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      return chromium.launch({
        args: [
          // containers get a small default /dev/shm and Chromium crashes on it mid-render
          '--disable-dev-shm-usage',
        ],
      })
    })()
    // if the launch fails, do not cache the rejection — the next request should retry
    browserPromise.catch(() => { browserPromise = null })
  }

  const browser = await browserPromise
  // a browser can die under us (OOM kill, container restart); relaunch rather than
  // failing every subsequent render with "Target closed"
  if (!browser.isConnected()) {
    browserPromise = null
    return getBrowser()
  }
  return browser
}

export interface PdfOptions {
  /** chase a stable filename for the download */
  landscape?: boolean
  timeoutMs?: number
  /** how long a render may wait for the document's webfont — docs/83 §5 */
  fontTimeoutMs?: number
}

/**
 * Wait, bounded, for the document's own typeface to be usable — and say whether it was.
 *
 * 🔴 docs/83 §5 — THE SAME INVOICE RENDERED TWO DIFFERENT DOCUMENTS.
 *
 * Twelve concurrent renders of ADP/26-27/0026 came back as two distinct files: ten at 78 KB
 * and two at 435 KB. Both were valid, both said Poppins, and they broke their lines
 * differently — the supplier block put GSTIN and PAN on one line in one and on two in the
 * other. The archived copy is the 435 KB kind, so the ten were the wrong one, and which kind
 * you got depended on a race.
 *
 * The cause is that the template loads Poppins from fonts.googleapis.com with
 * `display=swap`, and `setContent` was awaited on `domcontentloaded` — which does not wait
 * for an external stylesheet. So at the moment `page.pdf()` ran, the @font-face rules might
 * not be registered at all: there was nothing for `document.fonts.ready` to be waiting on, it
 * resolved immediately, and the page was laid out in the fallback's metrics.
 *
 * That matters more than typography. docs/59 archives the bytes issued precisely so the
 * question "what did you send" has one answer; a renderer that produces a different document
 * on a different day answers it twice.
 *
 * Still BOUNDED, and still never fatal — the original reasoning holds. If Google is slow or
 * blocked the document must render anyway, in whatever face is available. What changes is
 * that it now waits long enough to be consistent when the font IS reachable, and **says so
 * in the log when it is not**, instead of quietly issuing a differently-typeset invoice.
 */
async function awaitFont(page: Page, budgetMs: number): Promise<{ faces: number; loaded: number }> {
  // 🔴 a STRING, not an arrow function — see the note on the fonts.ready call below.
  return page.evaluate(`(async () => {
    // force layout, so the renderer actually requests the faces this document uses
    document.body.getBoundingClientRect()
    const started = Date.now()
    const left = () => ${budgetMs} - (Date.now() - started)
    // the @font-face rules arrive with a stylesheet domcontentloaded does not wait for, so
    // there may be nothing registered yet for fonts.ready to resolve against
    while (document.fonts.size === 0 && left() > 0) await new Promise((r) => setTimeout(r, 25))
    if (document.fonts.size === 0) return { faces: 0, loaded: 0 }
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, Math.max(0, left()))),
    ])
    let loaded = 0
    document.fonts.forEach((f) => { if (f.status === 'loaded') loaded++ })
    return { faces: document.fonts.size, loaded }
  })()`) as Promise<{ faces: number; loaded: number }>
}

export async function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const browser = await getBrowser()
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    page.setDefaultTimeout(opts.timeoutMs ?? 20_000)

    // 🔴 `domcontentloaded`, not `networkidle`. The template loads a web font from Google;
    // if that host is slow or blocked, `networkidle` never settles and the request hangs
    // until the timeout. The document must render with whatever it has.
    await page.setContent(html, { waitUntil: 'domcontentloaded' })

    // Give webfonts a bounded chance to arrive so the PDF is not laid out in a fallback
    // face — but never block the render on them. See `awaitFont` for why the old one-liner
    // here did not wait at all.
    //
    // 🔴 Passed as a STRING, not an arrow function. Bundlers that keep function names
    // (esbuild's keepNames, which tsx turns on) rewrite a transpiled closure to reference a
    // `__name` helper that does not exist inside the page. The call then throws, the
    // `.catch` swallows it, and the font wait silently never happens — the PDF quietly
    // renders in a fallback face and nothing reports it.
    const font = await awaitFont(page, opts.fontTimeoutMs ?? 5_000).catch(() => ({ faces: 0, loaded: 0 }))
    if (font.loaded === 0) {
      // 🔴 Reported, not swallowed. This document is laid out in a fallback face and will not
      // match the copy archived when the font was reachable — the one thing docs/59 exists to
      // prevent. Nothing above this line can tell, so it is said here.
      console.warn(
        `pdf · rendered without the document typeface (${font.faces} face(s) registered, none loaded) —`
        + ' the layout will not match a render made with it. Is fonts.googleapis.com reachable?',
      )
    }

    return await page.pdf({
      format: 'A4',
      landscape: opts.landscape ?? false,
      // 🔴 the template already sets its own @page margins and the backgrounds carry the
      // brand bar and table rules — without printBackground the invoice prints bare
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      preferCSSPageSize: true,
    })
  } finally {
    // close the context, not just the page — a context holds cookies and storage
    await context.close().catch(() => {})
  }
}

/** Release the shared browser. Called on shutdown and by the test teardown. */
export async function closePdfBrowser(): Promise<void> {
  if (!browserPromise) return
  const browser = await browserPromise.catch(() => null)
  browserPromise = null
  await browser?.close().catch(() => {})
}

/** A filename a person can find again: ADP-26-27-0026.pdf */
export function pdfFilename(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-')}.pdf`
}
