/**
 * 🔴 docs/95 — a script that WRITES demo data must know it is not writing into the real books.
 *
 * `scripts/tmp-fullseed.mts` raises invoices, credit notes, receipts, bills, a payroll-adjacent
 * tax estimate and an invitation against whatever `DATABASE_URL` points at, and looks up its
 * company by a hard-coded PAN — which is the company's REAL one. On the production box that is a
 * dozen fictitious documents in the live ledger, numbered into the live GST series, and nothing
 * in the database can take them out again (design rule 2: nothing financial is deleted).
 *
 * docs/83 §8 is the same lesson from the other side: a test wiped the dev database because
 * nothing checked its name. The name is no help here — production and development are BOTH
 * called `adpedia` (docs/90 step 4) — but the port is: the project-local dev cluster is 5461 and
 * production Postgres is 5432. So:
 *
 *   allowed:  host localhost/127.0.0.1 on port 5461, or any database whose name ends `_test`;
 *   anything else needs `ALLOW_FULLSEED_ON=<host:port/db>` spelled out exactly;
 *   NODE_ENV=production is always refused.
 */
export function assertScratchDatabase(
  url = process.env.DATABASE_URL,
  opts: { allow?: string; nodeEnv?: string } = { allow: process.env.ALLOW_FULLSEED_ON, nodeEnv: process.env.NODE_ENV },
): void {
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (opts.nodeEnv === 'production') throw new Error('Refusing to write demo data with NODE_ENV=production.')

  let u: URL
  try { u = new URL(url) } catch { throw new Error('DATABASE_URL is not a URL this guard can read, so it cannot say where demo data would go.') }
  const host = u.hostname
  const port = u.port || '5432'
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const where = `${host}:${port}/${db}`

  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (local && port === '5461') return
  if (db.endsWith('_test')) return
  if (opts.allow === where) return

  throw new Error(
    `Refusing to write demo data to ${where}.\n` +
    'This script raises fictitious invoices, receipts and bills, and nothing financial can be deleted afterwards.\n' +
    'It runs against the project-local dev cluster (localhost:5461) or a *_test database. If this really is a ' +
    `scratch database, say so by naming it exactly:  ALLOW_FULLSEED_ON=${where}`,
  )
}
