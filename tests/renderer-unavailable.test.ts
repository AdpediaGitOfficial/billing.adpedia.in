import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rendererUnavailable } from '@/server/services/invoicing/pdf'
import { RendererUnavailable } from '@/server/errors'

/**
 * 🔴 docs/85 — a server that cannot make a PDF must say so.
 *
 * The deployed box returned "Could not render the invoice" for every document, which is the
 * generic message every unexpected failure in a file route gets. It is the right message for
 * an unexpected failure. A Chromium that will not start is not unexpected: it is one of three
 * known shapes, it takes out every document in the system at once, and the person reading the
 * screen is the only one who can fix it.
 */
describe('🔴 the renderer says what is wrong with it', () => {
  // the real text, as Playwright writes it
  const NOT_INSTALLED =
    "browserType.launch: Executable doesn't exist at /home/adpedia/.cache/ms-playwright/"
    + 'chromium-1148/chrome-linux/chrome\n'
    + '╔═════════════════════════════════════════════════════════════════════════╗\n'
    + '║ Looks like Playwright was just installed or updated.                    ║\n'
    + '║ Please run the following command to download new browsers:              ║\n'
    + '║     npx playwright install                                              ║\n'
    + '╚═════════════════════════════════════════════════════════════════════════╝'

  const NO_LIBS =
    'browserType.launch: Host system is missing dependencies to run browsers. '
    + 'Please install them with the following command:\n    npx playwright install-deps\n'
    + 'Missing libraries:\n    libnss3.so\n    libgbm.so.1'

  const DIED = 'page.pdf: Target page, context or browser has been closed'

  it('names the install when the browser is not there', () => {
    const e = rendererUnavailable(new Error(NOT_INSTALLED))
    expect(e).toBeInstanceOf(RendererUnavailable)
    expect(e!.status).toBe(503)
    expect(e!.message).toMatch(/playwright install chromium/)
    // 🔴 the wrong-user install is the commonest version of this and it is not obvious
    expect(e!.message).toMatch(/as the user the application runs as/)
  })

  it('distinguishes a missing browser from missing system libraries', () => {
    const libs = rendererUnavailable(new Error(NO_LIBS))!
    expect(libs.message).toMatch(/install-deps/)
    // 🔴 the two fixes are different commands and one needs root. Telling someone to run
    // `playwright install` when the browser is already installed wastes the one thing they have
    expect(libs.message).not.toMatch(/playwright install chromium/)
  })

  it('reads a browser that vanished mid-render as memory', () => {
    const e = rendererUnavailable(new Error(DIED))!
    expect(e.message).toMatch(/memory/)
  })

  /**
   * 🔴 docs/80's rule, and the reason the classifier matches rather than catching everything.
   *
   * A Prisma error carries table names, column names and fragments of the query, and this
   * message goes to a browser. Anything not recognised must stay generic and go to the log.
   */
  it('leaves anything it does not recognise alone', () => {
    expect(rendererUnavailable(new Error(
      'Invalid `prisma.invoice.findFirst()` invocation: Unknown column `Invoice.secretRate`',
    ))).toBeNull()
    expect(rendererUnavailable(new Error('ECONNREFUSED 127.0.0.1:5461'))).toBeNull()
    expect(rendererUnavailable('a string, not an Error')).toBeNull()
  })
})

/* ── the sweep ───────────────────────────────────────────────────────────────── */

function files(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, ext, out)
    else if (e.endsWith(ext)) out.push(p)
  }
  return out
}

const documentRoutes = files(join(process.cwd(), 'src', 'app', 'api'), 'route.ts')
  .filter((p) => p.endsWith(join('document', 'route.ts')))

/**
 * 🔴 The guard proves it can SEE the routes before it asserts anything about them.
 *
 * A sweep that finds nothing passes, and a passing test that inspected zero files is worse
 * than no test: a green tick nobody questions again. The first version of this one also
 * assumed four routes and found five — `reports/document` renders statements and archives
 * none of them, which is correct and is why the archive rule below is conditional.
 */
describe('🔴 every document route serves a document the same way', () => {
  it('finds the document routes at all', () => {
    expect(documentRoutes.length, 'the sweep matched no document routes').toBeGreaterThanOrEqual(5)
  })

  it.each(documentRoutes.map((p) => [p.split('/api/')[1], p] as const))(
    '%s',
    (_label, path) => {
      const src = readFileSync(path, 'utf8')

      // one disposition rule, in one place — `?download=1` was added to the invoice in
      // docs/83 §6 and to nothing else, so three other documents could be looked at and not saved
      expect(src, 'hand-rolls its own content-disposition instead of using pdfHeaders')
        .toMatch(/pdfHeaders\(/)
      expect(src).not.toMatch(/'content-disposition'/)

      // 🔴 and every one of them can still be ASKED for the file. `pdfHeaders` requires the
      // decision, so a route cannot forget to make it — this checks it is the caller's
      // question that decides and not a constant somebody typed.
      expect(src, 'never reads ?download=1, so this document can only ever be previewed')
        .toMatch(/wantsDownload\(url\)/)

      /**
       * 🔴 `readAttachment` on an archived row is the defect itself: a row pointing at bytes
       * that are gone — a storage directory not carried across in a move, a STORAGE_DIR that
       * changed — threw, and a document the database could have rebuilt in a second came out
       * as a flat 500.
       */
      expect(src, 'reads the archived attachment directly instead of through archivedDocumentBytes')
        .not.toMatch(/readAttachment\(ctx, archived/)

      // a route that serves an archive at all must do it through the helper that can fall back
      if (/archivedDocument\b/.test(src)) {
        expect(src, 'serves an archive without the fallback').toMatch(/archivedDocumentBytes\(/)
      }
    },
  )

  it('🔴 and four of them do serve an archive — the rule is not vacuous', () => {
    const serving = documentRoutes.filter((p) => /archivedDocumentBytes\(/.test(readFileSync(p, 'utf8')))
    expect(serving.length).toBe(4)
  })
})
