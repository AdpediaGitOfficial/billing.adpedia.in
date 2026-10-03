import { prisma } from '@/server/db'
import { runNotifications } from '@/server/services/notify/schedule'
import { timingSafeEqual, createHash } from 'node:crypto'

/**
 * The scheduled run — docs/60.
 *
 * 🔴 There is no scheduler inside a Next.js app, and pretending otherwise with a `setInterval`
 * in a module would fire once per server process, silently stop on a restart, and run four
 * times behind a load balancer. So the schedule lives OUTSIDE — launchd, cron, a platform
 * scheduler — and calls this once a day. What lives here is the decision about what to send,
 * which is the part that belongs in the application.
 *
 * 🔴 This is the only route in the system with no signed-in user, so it carries its own
 * secret. With `CRON_SECRET` unset it REFUSES rather than running open: a scheduler endpoint
 * that falls back to "no auth configured, so allow" is one HTTP request away from anyone on
 * the internet being able to make this company's phones buzz.
 */
export async function POST(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected || expected.length < 16) {
    return json({ error: 'CRON_SECRET is not set, so this endpoint is disabled' }, 503)
  }

  const presented = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!constantTimeEquals(presented, expected)) {
    return json({ error: 'Not authorised' }, 401)
  }

  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry') === '1'
  // 🔴 the date is an input, so a run can be rehearsed against a day that matters. It is
  // only honoured in a dry run — a real send must be about today, or the idempotency key
  // means nothing.
  const asked = url.searchParams.get('on')
  const on = dryRun && asked && !Number.isNaN(Date.parse(asked)) ? new Date(asked) : new Date()

  const companies = await prisma.company.findMany({ select: { id: true, legalName: true } })
  const out: Record<string, unknown>[] = []

  for (const company of companies) {
    // the run is not a user action; it acts with the company's own authority
    const ctx = { userId: null as unknown as string, companyId: company.id, role: 'OWNER' as const }
    try {
      const r = await runNotifications(ctx, on, { dryRun })
      out.push({ company: company.legalName, ...r })
    } catch (e) {
      // 🔴 one company's failure must not stop the others being told anything
      out.push({ company: company.legalName, error: e instanceof Error ? e.message : 'failed' })
    }
  }

  return json({ on: on.toISOString().slice(0, 10), dryRun, companies: out }, 200)
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * 🔴 Length-independent and content-independent comparison.
 *
 * `a === b` on a secret leaks it one character at a time to anyone who can measure the
 * response. `timingSafeEqual` throws on a length mismatch, which leaks the length — so both
 * sides are hashed to a fixed width first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
