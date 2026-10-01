// Static import: the module only loads where it is used (the document route), and a
// dynamic one breaks under bundlers that compile to a data: URL with no base to resolve
// against. Chromium itself is still launched lazily, on the first render.
import { chromium, type Browser } from 'playwright'

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
    // face — but never block the render on them.
    //
    // 🔴 Passed as a STRING, not an arrow function. Bundlers that keep function names
    // (esbuild's keepNames, which tsx turns on) rewrite a transpiled closure to reference a
    // `__name` helper that does not exist inside the page. The call then throws, the
    // `.catch` swallows it, and the font wait silently never happens — the PDF quietly
    // renders in a fallback face and nothing reports it.
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => {})

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
