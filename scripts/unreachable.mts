/**
 * The survey docs/49 §1 said should be a script and never was — docs/80.
 *
 * It looks for the defect class this project keeps finding: **a service with tests and no
 * caller**, which reads as finished because the tests are green. Four of them have shipped that
 * way — `cancelReceipt` and friends (`docs/49`), `validateInvoiceNumber` (`docs/64`),
 * `listRefundVouchers` and `listCreditNotes` (`docs/69`), and `cancelAdvanceTaxPayment`, which
 * `docs/72` wrote in the same module that argued against leaving exactly this.
 *
 * 🔴 It counts calls, not mentions, and it counts them INSIDE the defining file too — otherwise
 * every helper a module exports for its own tests reads as dead and the report is noise nobody
 * finishes. What it reports is a function nothing but a test invokes.
 *
 *   npx tsx scripts/unreachable.mts          every one
 *   npx tsx scripts/unreachable.mts --actions  only the ones that write
 *
 * ⚠️ What it cannot see, so that a clean run is not read as more than it is:
 *
 *   · **an indirect call.** `form.due(x)` where `due` was assigned `aoc4Due` reads as no call
 *     at all, so a few live functions appear in the full listing. Check before deleting.
 *   · **a dynamic import**, and anything reached through a string.
 *
 * Both of those produce FALSE ALARMS, never false silence — a function it says is called really
 * is. The full listing is a reading list; `--actions` is the one that should stay empty.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const TESTS = join(ROOT, 'tests')
const SERVICES = join(SRC, 'server', 'services')

/** 🔴 Comments do not call anything, and this file is full of function names in prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
     .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))

const all = [...files(SRC), ...files(TESTS)]
const bodies = new Map(all.map((f) => [f, code(readFileSync(f, 'utf8'))]))
const onlyActions = process.argv.includes('--actions')

/** Something that changes state, as opposed to a read or a pure helper. */
const ACTION = /^(create|update|set|record|post|cancel|reverse|approve|send|delete|remove|revoke|accept|apply|close|reopen|lock|unlock|register|invite|adjust|pay|refund|import|generate|allocate|confirm|detach|unmatch|learn)/

/**
 * 🔴 Named exemptions, each with the reason — the same shape as `tests/marker-leak.test.ts`'s.
 *
 * A survey that reports four things it is fine with every time is one nobody finishes reading,
 * which is `docs/60 §3` about a different screen. Everything here is deliberate, and if the
 * reason stops being true the entry should go rather than the line it exempts.
 */
const DELIBERATE: Record<string, string> = {
  closePdfBrowser: 'teardown, not a business action — Chromium holds the event loop open, so every suite that renders calls it',
  setStorageDriver: 'a test seam for the storage driver (docs/38); production uses the default',
  registerEInvoice: 'e-invoicing is gated on turnover and on a live IRP client that is a deliberate non-goal (docs/31 §6, docs/75)',
  cancelEInvoice: 'the pair of registerEInvoice, and unreachable for the same reason',
}

const rows: { fn: string; file: string; calls: number; tests: number }[] = []
for (const f of files(SERVICES)) {
  const self = bodies.get(f)!
  for (const m of self.matchAll(/^export (?:async )?function (\w+)/gm)) {
    const fn = m[1]
    if (onlyActions && !ACTION.test(fn)) continue
    const call = new RegExp(`\\b${fn}\\s*\\(`, 'g')
    let calls = 0, tests = 0
    for (const [other, body] of bodies) {
      // a definition is not a call
      const hits = (body.match(call) ?? []).length
        - (body.match(new RegExp(`function ${fn}\\s*\\(`, 'g')) ?? []).length
      if (hits <= 0) continue
      if (other.startsWith(TESTS)) tests += hits; else calls += hits
    }
    if (calls === 0 && !DELIBERATE[fn]) rows.push({ fn, file: f.slice(SRC.length + 1), calls, tests })
  }
}

rows.sort((a, b) => b.tests - a.tests || a.fn.localeCompare(b.fn))
if (rows.length === 0) {
  console.log(`No ${onlyActions ? 'action ' : ''}service is called only from tests.`)
  console.log(`${Object.keys(DELIBERATE).length} deliberate exemptions, each with its reason in the script.`)
} else {
  console.log(`${rows.length} ${onlyActions ? 'action ' : ''}service function(s) nothing but a test calls:\n`)
  for (const r of rows) console.log(`  ${r.fn.padEnd(30)} ${r.file.padEnd(46)} tests:${r.tests}`)
  console.log('\nEach is either a gap (no screen can reach it) or dead code. Neither should stay.')
}
process.exit(rows.length === 0 ? 0 : 1)
