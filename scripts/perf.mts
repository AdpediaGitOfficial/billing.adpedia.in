/**
 * The performance budget, measured — docs/13 §4, docs/68 §4.
 *
 * `FCP < 1.5s on 4G · interactive < 3s · virtualised lists past 50 rows · route-level code
 * splitting so an employee filing an expense never downloads the GL.` Written in phase 0 and
 * never once measured, which is how `lucide-react` came to ship 1,544 icons to every route.
 *
 * Usage:  npm run build && npm start &  then  npx tsx scripts/perf.mts
 *   --url      base URL (default http://localhost:3000)
 *   --email    sign-in email      (or PERF_EMAIL)
 *   --password sign-in password   (or PERF_PASSWORD)
 *   --routes   comma-separated paths to walk
 *
 * 🔴 It must be run against a PRODUCTION build. `next dev` compiles on demand, serves
 * unminified modules and ships a hot-reload client, so a dev number is three or four times
 * the real one and bears no relation to it — measuring the wrong thing is worse than not
 * measuring, because somebody acts on it.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

/* Lighthouse's "Slow 4G": the standard mobile throttle, and the conservative end of what a
 * phone outside an office actually gets. Stated here because a figure whose conditions are
 * not written down cannot be compared with the next one. */
const NET = { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150, offline: false }
const CPU_SLOWDOWN = 4

/**
 * 🔴 `jsKb` is not in docs/13's budget, and it is the line that would have caught the thing
 * this script was written to look for.
 *
 * The namespace import of `lucide-react` put 650 kB of unused icons on every cold visit, and
 * FCP did not move: the HTML is server-rendered and paints before the JavaScript arrives, so
 * a page can be two and a half times too heavy and still pass a budget written in paint
 * timings. What it costs is `load`, the battery and somebody's data — ~2.45s against ~1.55s
 * here, on a server with no distance to it. The ceiling is set a little above where the app
 * sits so that another library-sized mistake trips it, and so that ordinary growth does not.
 */
const BUDGET = { fcpMs: 1500, interactiveMs: 3000, jsKb: 550 }

/**
 * 🔴 What this number is NOT.
 *
 * The server is local, so there is no distance to it and no queue in front of it: the
 * throttle shapes the link, not the hosting. A deployed server adds its own time to first
 * byte, and every figure here moves by that amount. What this measures honestly is the cost
 * of the page itself on a slow link and a slow phone — which is the half the code controls,
 * and the half that regressed by 150 kB without anybody noticing.
 */
const CAVEAT = 'Local server: no hosting latency included. These are the client\'s own costs.'

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const BASE = arg('url', process.env.PERF_URL ?? 'http://localhost:3000')
const EMAIL = arg('email', process.env.PERF_EMAIL ?? '')
const PASSWORD = arg('password', process.env.PERF_PASSWORD ?? '')
/**
 * Every page that renders a list or a grid. 🔴 Not a sample: the sideways-scrolling tables
 * this found were on the pages a shortlist would have left out, because the pages anybody
 * thinks to check are the ones that were already right.
 */
const ROUTES = arg('routes', [
  '/dashboard', '/invoices', '/expenses', '/bills', '/receipts', '/customers', '/vendors', '/projects',
  '/approvals', '/chases',
  '/tax/gst', '/tax/tds', '/tax/tds-receivable', '/tax/pan', '/tax/portal', '/tax/calendar',
  '/accounting/journal', '/accounting/trial-balance', '/accounting/accounts', '/accounting/close',
  '/reports', '/reports/pnl', '/reports/balance-sheet', '/reports/cash-flow', '/reports/ageing',
  '/payroll/employees', '/payroll/runs', '/payroll/me',
  '/banking/reconcile', '/banking/import',
  '/settings/company', '/settings/users', '/settings/series', '/settings/services',
  '/settings/reminders', '/settings/lut', '/settings/e-invoice', '/settings/device',
].join(',')).split(',').filter(Boolean)

if (!EMAIL || !PASSWORD) {
  console.error('Need --email and --password (or PERF_EMAIL / PERF_PASSWORD).')
  process.exit(2)
}

interface Row {
  route: string
  fcp: number | null
  interactive: number
  load: number
  jsKb: number
  domNodes: number
  cards: number
  tableRows: number
  overflow: string[]
}

/**
 * A COLD visit, with its own empty HTTP cache — the first paragraph of the budget is about
 * somebody opening the app on a phone, not about a warm route change. The session is carried
 * over as storage state so that signing in is not measured nine times.
 */
async function coldPage(browser: Browser, storageState: Awaited<ReturnType<BrowserContext['storageState']>>) {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: UA,
    storageState,
  })
  const pg = await ctx.newPage()
  const cdp = await ctx.newCDPSession(pg)
  await cdp.send('Network.emulateNetworkConditions', NET)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  return { ctx, pg }
}

async function measure(page: Page, route: string): Promise<Row> {
  let js = 0
  const onResponse = async (r: import('playwright').Response) => {
    const t = r.headers()['content-type'] ?? ''
    if (!t.includes('javascript')) return
    try { js += (await r.body()).byteLength } catch { /* redirect or aborted */ }
  }
  page.on('response', onResponse)
  await page.goto(BASE + route, { waitUntil: 'load' })
  page.off('response', onResponse)

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null
    return {
      fcp,
      /* 🔴 `domInteractive`, NOT Lighthouse's Time to Interactive. TTI needs a main-thread
       * quiet-window trace this script does not take. Named for what it is, because a figure
       * reported as something it is not is how a budget comes to be believed wrongly. */
      interactive: nav?.domInteractive ?? 0,
      load: nav?.loadEventEnd ?? 0,
      domNodes: document.getElementsByTagName('*').length,
      /* how many list rows each rendering actually put in the DOM — docs/68 §4. Both are
       * present at every width; CSS only hides one, so a phone pays for the table too. */
      cards: document.querySelectorAll('[data-list-row]').length,
      tableRows: document.querySelectorAll('tbody tr').length,
      /**
       * 🔴 docs/13 §4: "Tables become cards below 768px. NEVER a horizontally scrolling grid."
       * Six of them were, in five pages, for as long as those pages have existed — they are
       * not `DataTable` callers, so the rule's implementation never reached them, and nothing
       * else was ever going to notice. This is what noticed.
       */
      overflow: Array.from(document.querySelectorAll('table'))
        .filter((t) => t.offsetParent !== null && t.getBoundingClientRect().width > window.innerWidth + 1)
        .map((t) => `table ${Math.round(t.getBoundingClientRect().width)}px`)
        .concat(document.documentElement.scrollWidth > window.innerWidth + 1
          ? [`page ${document.documentElement.scrollWidth}px`] : []),
    }
  })
  return { route, fcp: m.fcp, interactive: m.interactive, load: m.load, jsKb: Math.round(js / 1024), domNodes: m.domNodes, cards: m.cards, tableRows: m.tableRows, overflow: m.overflow }
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

const browser = await chromium.launch()

/* Sign in first, unthrottled — the login round trip is not what is being measured. */
const signIn = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: UA })
const first = await signIn.newPage()
await first.goto(BASE + '/login', { waitUntil: 'load' })
await first.fill('input[type=email]', EMAIL)
await first.fill('input[type=password]', PASSWORD)
await Promise.all([first.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }), first.click('button[type=submit]')])
const session = await signIn.storageState()
await signIn.close()

const rows: Row[] = []
for (const route of ROUTES) {
  const { ctx, pg } = await coldPage(browser, session)
  rows.push(await measure(pg, route))
  await ctx.close()
}

await browser.close()

const pad = (s: string | number, n: number) => String(s).padStart(n)
const padR = (s: string, n: number) => s.padEnd(n)
console.log(`\nSlow 4G (1.6 Mbps · 150 ms RTT) · CPU ×${CPU_SLOWDOWN} · 375×812 · ${BASE}`)
console.log(`Budget: FCP < ${BUDGET.fcpMs}ms · domInteractive < ${BUDGET.interactiveMs}ms · JS < ${BUDGET.jsKb}kB · nothing scrolling sideways`)
console.log(`Each route a COLD first visit, empty cache. ${CAVEAT}\n`)
console.log(`${padR('route', 28)}${pad('FCP', 8)}${pad('interactive', 13)}${pad('load', 8)}${pad('JS kB', 8)}${pad('DOM', 7)}${pad('cards', 7)}${pad('tr', 5)}`)
console.log('─'.repeat(72))
let missed = 0
for (const r of rows) {
  const bad = (r.fcp ?? Infinity) > BUDGET.fcpMs || r.interactive > BUDGET.interactiveMs
    || r.jsKb > BUDGET.jsKb || r.overflow.length > 0
  if (bad) missed += 1
  console.log(
    `${padR(r.route, 28)}${pad(r.fcp === null ? '—' : Math.round(r.fcp), 8)}${pad(Math.round(r.interactive), 13)}` +
    `${pad(Math.round(r.load), 8)}${pad(r.jsKb, 8)}${pad(r.domNodes, 7)}${pad(r.cards, 7)}${pad(r.tableRows, 5)}  ${bad ? '← over budget' : ''}`,
  )
  for (const o of r.overflow) console.log(`${' '.repeat(28)}🔴 ${o} at ${375}px — docs/13 §4 says never`)
}
console.log('─'.repeat(72))
console.log(missed === 0 ? `All ${rows.length} routes within budget.` : `${missed} of ${rows.length} routes over budget.`)
process.exit(missed === 0 ? 0 : 1)
