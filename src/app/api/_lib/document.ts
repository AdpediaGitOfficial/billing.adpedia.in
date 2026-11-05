/**
 * The headers a rendered document goes out with — docs/85 §3.
 *
 * 🔴 Five copies of this header block existed across four routes, and they had already
 * drifted: `?download=1` was added to the invoice in docs/83 §6 and nowhere else, so a credit
 * note, a payslip and a voucher could be looked at and not saved. The drift is the argument
 * for one function — the rule is the same document rule in every case, and it was only ever
 * written down once by accident.
 */
export function pdfHeaders(
  name: string,
  opts: { download: boolean; source: 'archived-at-issue' | 'rebuilt-now' },
): HeadersInit {
  return {
    'content-type': 'application/pdf',
    /**
     * 🔴 `inline` by default, deliberately: tapping an invoice on a phone should open a
     * preview rather than drop a file into Downloads that the person then has to go and find.
     * `?download=1` says the FILE is what was wanted, which is a different intention and not
     * one the browser's own save button can express reliably against a `no-store` response.
     */
    'content-disposition': `${opts.download ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`,
    /**
     * 🔴 Whether these bytes are the ones that were ISSUED or a reconstruction made now —
     * docs/59. The two are indistinguishable in the file itself, which is the entire reason
     * the archive exists.
     */
    'x-document-source': opts.source,
    // private, not merely no-store: a payslip must never sit in a shared proxy cache
    'cache-control': 'private, no-store',
  }
}

/** The HTML of the same document — `?format=html`, which never comes from the archive. */
export function documentHtmlHeaders(): HeadersInit {
  return {
    'content-type': 'text/html; charset=utf-8',
    'x-document-source': 'rebuilt-now',
    'cache-control': 'private, no-store',
  }
}

/** Did the caller ask for the file rather than a preview? */
export function wantsDownload(url: URL): boolean {
  return url.searchParams.get('download') === '1'
}
