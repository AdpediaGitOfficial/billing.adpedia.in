import { prisma } from '@/server/db'
import { Decimal } from '@/lib/money'

/**
 * docs/94 — a live exchange rate, as a SUGGESTION.
 *
 * 🔴 It feeds the rate field on the invoice, bill and re-book forms and nothing else. The rate a
 * document is booked at is copied onto the document when it is saved and is frozen there; a rate
 * that moved after the invoice was issued must not move the books. This table only remembers what
 * was offered.
 *
 * Rupees per ONE unit of the currency. Two sources, tried in order:
 *  1. the ECB reference rates through frankfurter.dev — official, published once a working day,
 *     and with history, so a past date asks for ITS rate rather than today's;
 *  2. open.er-api.com — covers currencies the ECB does not publish (the dirham, the riyal …) but
 *     only for NOW, so it is never used to answer a past date.
 *
 * Neither is a tick-by-tick quote — both update about once a day — and neither is the RBI
 * reference rate or a bank's rate. Say so wherever the figure is shown; the person decides what
 * to book at, and the CA decides which rate the law wants.
 *
 * Only a currency code and a date leave the server. Nothing about the company or its documents.
 */

export interface LiveRate {
  currency: string
  rate: Decimal
  /** the date the source says the rate is from — earlier than `requested` on a weekend */
  asOf: string
  requested: string
  source: string
  /** true when the source could not be reached and this is the last rate that was fetched */
  stale: boolean
}

export interface FxDeps {
  fetch?: typeof fetch
  now?: () => Date
}

/** today's rate is re-fetched after this; a past date's never is */
const TODAY_TTL_MS = 30 * 60 * 1000
const TIMEOUT_MS = 4000

const day = (d: Date) => d.toISOString().slice(0, 10)

function sane(rate: unknown): Decimal | null {
  const n = typeof rate === 'number' ? rate : Number(rate)
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null
  return new Decimal(n.toFixed(6))
}

async function fromFrankfurter(currency: string, date: string | null, f: typeof fetch) {
  const res = await f(`https://api.frankfurter.dev/v1/${date ?? 'latest'}?base=${currency}&symbols=INR`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) return null
  const j = await res.json() as { date?: string; rates?: { INR?: number } }
  const rate = sane(j.rates?.INR)
  return rate && j.date ? { rate, asOf: j.date, source: 'ECB reference rate' } : null
}

async function fromErApi(currency: string, f: typeof fetch) {
  const res = await f(`https://open.er-api.com/v6/latest/${currency}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) return null
  const j = await res.json() as { result?: string; time_last_update_utc?: string; rates?: { INR?: number } }
  const rate = sane(j.rates?.INR)
  if (j.result !== 'success' || !rate) return null
  const asOf = j.time_last_update_utc ? day(new Date(j.time_last_update_utc)) : day(new Date())
  return { rate, asOf, source: 'open.er-api.com' }
}

/**
 * The rate for `currency` on `onDate` (default today), or null when there is none to offer.
 * Past dates are cached for good; today's is refreshed every half hour; a failed fetch falls
 * back to the last rate held, marked stale, rather than to nothing.
 */
export async function liveRate(currency: string, onDate?: string, deps: FxDeps = {}): Promise<LiveRate | null> {
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code) || code === 'INR') return null

  const now = (deps.now ?? (() => new Date()))()
  const today = day(now)
  let requested = onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : today
  if (Number.isNaN(new Date(requested).getTime())) return null
  if (requested > today) requested = today   // nobody can ask for a rate that has not happened

  const cached = await prisma.exchangeRate.findUnique({
    where: { currency_requestedDate: { currency: code, requestedDate: new Date(requested) } },
  })
  const asLive = (c: NonNullable<typeof cached>, stale: boolean): LiveRate => ({
    currency: code, rate: new Decimal(c.rate.toString()), asOf: day(c.asOfDate), requested: day(c.requestedDate), source: c.source, stale,
  })
  if (cached && (requested < today || now.getTime() - cached.fetchedAt.getTime() < TODAY_TTL_MS)) return asLive(cached, false)

  if (process.env.FX_LIVE_RATES !== 'off') {
    const f = deps.fetch ?? fetch
    let got: { rate: Decimal; asOf: string; source: string } | null = null
    try { got = await fromFrankfurter(code, requested < today ? requested : null, f) } catch { /* try the next */ }
    // the second source only knows NOW, so it never answers a past date
    if (!got && requested === today) { try { got = await fromErApi(code, f) } catch { /* fall through */ } }

    if (got) {
      const row = await prisma.exchangeRate.upsert({
        where: { currency_requestedDate: { currency: code, requestedDate: new Date(requested) } },
        update: { rate: got.rate.toFixed(6), asOfDate: new Date(got.asOf), source: got.source, fetchedAt: now },
        create: { currency: code, requestedDate: new Date(requested), asOfDate: new Date(got.asOf), rate: got.rate.toFixed(6), source: got.source, fetchedAt: now },
      })
      return asLive(row, false)
    }
  }

  // the source is down, or switched off: the same date if there is one, else the latest held
  if (cached) return asLive(cached, true)
  const latest = await prisma.exchangeRate.findFirst({ where: { currency: code }, orderBy: { requestedDate: 'desc' } })
  return latest ? asLive(latest, true) : null
}
