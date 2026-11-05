import { prisma } from '@/server/db'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { htmlToPdf } from '@/server/services/invoicing/pdf'
import { storage, newStorageKey } from '@/server/services/storage/driver'
import { unarchivedInvoices } from '@/server/services/storage/document-archive'
import { handler } from '@/app/api/_lib/handler'
import { NextResponse } from 'next/server'

/**
 * Is this box well? — docs/85 §2.
 *
 * 🔴 docs/90 listed "no health route" under *Known gaps on the box*, and the gap cost
 * something real. A deployed install could not produce a single PDF, and from a phone the
 * entire diagnosis available was the sentence "Could not render the invoice" — the cause was
 * in a pm2 log, which needs ssh, which is not what the person holding the phone has. Every
 * invoice, credit note, voucher and payslip in this system goes through the same Chromium, so
 * one missing browser takes out every document at once and looks exactly like a broken
 * invoice.
 *
 * Two depths, for two different readers:
 *
 * - **`GET /api/health`** — public, no session, the database and nothing else. This is what a
 *   monitor should watch. docs/90 suggested pointing it at `/login`, which returns 200 for as
 *   long as Next is running even if Postgres is gone.
 * - **`GET /api/health?deep=1`** — signed in, OWNER only, and it actually *exercises* the
 *   subsystems: it writes and re-reads a file, and it renders a real PDF. 🔴 A check that
 *   reports on a renderer without running it reports that the renderer is configured, which is
 *   not the question ever being asked.
 *
 * It is OWNER-only and not merely signed-in because the deep check launches a browser, and an
 * endpoint that forks Chromium for anyone who asks is a way to take the box down.
 */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get('deep') === '1'

  if (!deep) {
    return handler(async () => {
      const t = Date.now()
      await prisma.$queryRaw`SELECT 1`
      return NextResponse.json({ ok: true, database: { ok: true, ms: Date.now() - t } })
    })
  }

  return handler(async () => {
    const ctx = await requireContext()
    // 🔴 `write`, which is OWNER alone. AUDITOR holds settings.company at `read`.
    assertCan(ctx.role, 'settings.company', 'write')

    const [database, store, renderer, archive] = await Promise.all([
      checkDatabase(), checkStorage(), checkRenderer(), checkArchive(ctx),
    ])
    const ok = database.ok && store.ok && renderer.ok
    // 🔴 503 when it is not well, so a monitor and a person reading the JSON agree
    return NextResponse.json({ ok, database, storage: store, renderer, archive }, { status: ok ? 200 : 503 })
  })
}

type Check = { ok: boolean; ms: number; detail: string }

const timed = async (fn: () => Promise<string>): Promise<Check> => {
  const t = Date.now()
  try {
    // 🔴 awaited into a const FIRST. Written as `{ ok: true, ms: Date.now() - t, detail: await fn() }`
    // the properties evaluate in source order, so `ms` is read before the work has started and
    // every check reports 0 — a number that reads as "instant" rather than "never measured".
    const detail = await fn()
    return { ok: true, ms: Date.now() - t, detail }
  } catch (e) {
    // 🔴 the message, not the stack, and only from a check whose inputs this file wrote —
    // docs/80's rule is about errors carrying query fragments, and none of these touch user data
    return { ok: false, ms: Date.now() - t, detail: e instanceof Error ? e.message : String(e) }
  }
}

const checkDatabase = () => timed(async () => {
  await prisma.$queryRaw`SELECT 1`
  const [{ version }] = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`
  return version.split(' ').slice(0, 2).join(' ')
})

/**
 * 🔴 Writes, reads back, compares, removes. A storage check that only looks at configuration
 * passes on a box where the directory moved — which is the failure that makes an archived
 * invoice unreadable, and the one `archivedDocumentBytes` now survives.
 */
const checkStorage = () => timed(async () => {
  const driver = storage()
  const key = newStorageKey('_health', 'text/plain')
  const probe = Buffer.from(`health ${new Date().toISOString()}`)
  await driver.put(key, probe, 'text/plain')
  const back = await driver.get(key)
  await driver.remove(key)
  if (!back.equals(probe)) throw new Error('what was written to storage did not read back the same')
  return `${driver.name} · ${process.env.STORAGE_DIR ?? 'STORAGE_DIR unset, using .storage in the checkout'}`
})

/**
 * 🔴 Renders an actual document. The failure this exists to catch happens at
 * `chromium.launch()`, which nothing short of launching can observe.
 */
const checkRenderer = () => timed(async () => {
  const pdf = await htmlToPdf('<html><body><h1>health</h1></body></html>', { fontTimeoutMs: 1_000 })
  if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('the renderer returned something that is not a PDF')
  return `Chromium produced a ${(pdf.length / 1024).toFixed(0)} KB PDF`
})

/**
 * How many issued documents have no copy on file — docs/59.
 *
 * Not a pass or a fail: an invoice sent before the archive existed will be counted forever and
 * nothing is wrong with it. It belongs here because a renderer that has been broken for a week
 * shows up as a week of invoices with nothing on record, and that is worth seeing in one place.
 */
async function checkArchive(ctx: Awaited<ReturnType<typeof requireContext>>) {
  const missing = await unarchivedInvoices(ctx)
  return {
    issuedWithNoCopyOnFile: missing.length,
    numbers: missing.slice(0, 10).map((i) => i.number),
  }
}

/** Chromium needs the Node runtime; it cannot run on the edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
