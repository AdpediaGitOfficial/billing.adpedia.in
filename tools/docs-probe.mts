import { chromium } from 'playwright'
const BASE = process.env.WALK_URL ?? 'http://localhost:3101'
const ids: Record<string, string> = JSON.parse(process.env.WALK_IDS ?? '{}')

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
await page.goto(BASE + '/login')
await page.fill('input[type=email]', process.env.WALK_EMAIL!)
await page.fill('input[type=password]', process.env.WALK_PASSWORD!)
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])

const targets = [
  `/api/invoices/${ids.sent}/document`,
  `/api/invoices/${ids.draft}/document`,
  `/api/credit-notes/${ids.note}/document`,
  `/api/reports/document?statement=trial-balance`,
  `/api/reports/export?report=journal`,
  `/api/reports/export?report=trial-balance`,
  `/api/reports/export?report=ageing-ar`,
  `/api/tax/gst/export?type=gstr1`,
  `/api/tax/tds/export?quarter=1`,
  `/api/dashboard`,
]
let bad = 0
for (const t of targets) {
  try {
    const res = await page.request.get(BASE + t)
    const body = await res.body()
    const type = res.headers()['content-type'] ?? ''
    const head = body.subarray(0, 5).toString('latin1')
    const ok = res.status() < 400 && body.length > 200
    const pdfOk = !type.includes('pdf') || head.startsWith('%PDF')
    if (!ok || !pdfOk) bad += 1
    console.log(`${ok && pdfOk ? '  ' : '🔴'} ${res.status()} ${String(body.length).padStart(8)}B ${type.split(';')[0].padEnd(26)} ${t}`)
    if (!ok) console.log(`      ${body.subarray(0, 180).toString('utf8').replace(/\s+/g, ' ')}`)
  } catch (e) {
    bad += 1
    console.log(`🔴 ERR ${t} — ${(e as Error).message.slice(0, 120)}`)
  }
}
console.log(`\n${bad} of ${targets.length} document endpoints with a problem`)
await browser.close()
