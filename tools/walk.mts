import { chromium, type ConsoleMessage } from 'playwright'

const BASE = process.env.WALK_URL ?? 'http://localhost:3101'
const ROUTES = [
  '/dashboard', '/chases',
  '/customers', '/customers/new', '/projects', '/projects/new',
  '/invoices', '/invoices/new', '/invoices?page=2', '/invoices?page=999',
  '/notes', '/receipts', '/receipts/new', '/receipts/advance',
  '/vendors', '/vendors/new', '/bills', '/bills/new', '/expenses', '/expenses/new', '/expenses/capture',
  '/approvals',
  '/payroll/employees', '/payroll/runs', '/payroll/me',
  '/banking/reconcile', '/banking/import',
  '/tax/gst', '/tax/tds', '/tax/tds-receivable', '/tax/pan', '/tax/portal', '/tax/calendar', '/tax/advance',
  '/accounting/accounts', '/accounting/journal', '/accounting/journal?page=2',
  '/accounting/trial-balance', '/accounting/close',
  '/reports', '/reports/pnl', '/reports/balance-sheet', '/reports/cash-flow',
  '/reports/ageing', '/reports/ageing?side=ap', '/reports/client-pnl', '/reports/project-pnl',
  '/settings/company', '/settings/users', '/settings/series', '/settings/services',
  '/settings/reminders', '/settings/lut', '/settings/e-invoice', '/settings/device',
  '/more',
]

// detail routes, whose ids come in as JSON
const ids: Record<string, string> = JSON.parse(process.env.WALK_IDS ?? '{}')
if (ids.sent) {
  ROUTES.push(
    `/invoices/${ids.sent}`, `/invoices/${ids.sent}/credit-note`, `/invoices/${ids.sent}/debit-note`,
    `/invoices/${ids.sent}/amend`, `/invoices/${ids.sent}/edit`,
    `/invoices/${ids.draft}`, `/invoices/${ids.draft}/edit`,
    `/notes/${ids.note}/amend`,
    `/bills/${ids.bill}`, `/bills/${ids.approved}`,
    `/expenses/${ids.exp}`,
    `/customers/${ids.cust}`, `/vendors/${ids.vend}/edit`,
    `/projects/${ids.proj}`, `/projects/${ids.proj}/edit`,
    `/accounting/accounts/${ids.acct}`,
  )
}

const WIDTH = Number(process.env.WALK_WIDTH ?? '1280')
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  isMobile: WIDTH < 768, hasTouch: WIDTH < 768,
})
const page = await ctx.newPage()

await page.goto(BASE + '/login')
await page.fill('input[type=email]', process.env.WALK_EMAIL!)
await page.fill('input[type=password]', process.env.WALK_PASSWORD!)
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])

let problems = 0
for (const route of ROUTES) {
  const errors: string[] = []
  const onConsole = (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text().slice(0, 220)) }
  const onPageError = (e: Error) => errors.push('UNCAUGHT ' + e.message.slice(0, 220))
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  let status = 0
  try {
    const res = await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45_000 })
    status = res?.status() ?? 0
  } catch (e) {
    errors.push('NAV ' + (e as Error).message.slice(0, 160))
  }
  await page.waitForTimeout(250)

  const probe = await page.evaluate(() => {
    const body = document.body.innerText
    return {
      // Next's error overlay / error boundary text, and our own
      appError: /Application error|Unhandled Runtime Error|Internal Server Error|something went wrong/i.test(body),
      // a page that rendered nothing useful
      shortBody: body.trim().length < 80,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      title: document.title,
      firstLine: body.trim().split('\n').filter(Boolean)[0]?.slice(0, 70) ?? '',
    }
  })

  page.off('console', onConsole)
  page.off('pageerror', onPageError)

  const bad = status >= 400 || errors.length > 0 || probe.appError || probe.shortBody || probe.overflow
  if (bad) problems += 1
  const flags = [
    status >= 400 ? `HTTP ${status}` : '',
    probe.appError ? 'APP ERROR' : '',
    probe.shortBody ? 'EMPTY BODY' : '',
    probe.overflow ? 'OVERFLOWS' : '',
  ].filter(Boolean).join(' · ')
  console.log(`${bad ? '🔴' : '  '} ${route.padEnd(34)} ${status} ${flags}`)
  for (const e of errors.slice(0, 3)) console.log(`      ${e}`)
}

console.log(`\n${problems} of ${ROUTES.length} routes with something to look at, at ${WIDTH}px`)
await browser.close()
