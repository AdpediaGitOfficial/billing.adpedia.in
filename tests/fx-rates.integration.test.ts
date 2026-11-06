import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { liveRate } from '@/server/services/fx-rates'

/**
 * docs/94 — the live rate is a SUGGESTION. These tests stand in for the network, so nothing here
 * touches a real service, and read the table, because what is remembered is the point.
 */

const prisma = new PrismaClient()
const NOW = new Date('2026-11-06T09:00:00Z')

interface Call { url: string }
let calls: Call[] = []
let ecb: (url: string) => Response | null = () => null
let erApi: (url: string) => Response | null = () => null

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  calls.push({ url })
  const r = url.includes('frankfurter') ? ecb(url) : erApi(url)
  if (!r) throw new Error('network down')
  return r
}) as typeof fetch
const deps = (at = NOW) => ({ fetch: fakeFetch, now: () => at })

beforeAll(async () => { await resetDb(prisma) })
beforeEach(async () => {
  calls = []
  await prisma.exchangeRate.deleteMany()
  ecb = (url) => json({ amount: 1, base: 'USD', date: url.includes('2026-09-10') ? '2026-09-10' : '2026-11-05', rates: { INR: url.includes('2026-09-10') ? 95.44 : 94.48 } })
  erApi = () => json({ result: 'success', time_last_update_utc: 'Fri, 06 Nov 2026 00:02:31 +0000', rates: { INR: 94.537031 } })
  delete process.env.FX_LIVE_RATES
})
afterAll(async () => { delete process.env.FX_LIVE_RATES; await prisma.$disconnect() })

describe('a past date asks for ITS rate, and keeps it', () => {
  it('fetches the date once, then answers from what it holds — a past rate never changes', async () => {
    const r = await liveRate('USD', '2026-09-10', deps())
    expect(r!.rate.toFixed(2)).toBe('95.44')
    expect(r!.asOf).toBe('2026-09-10')
    expect(r!.requested).toBe('2026-09-10')
    expect(r!.source).toBe('ECB reference rate')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/2026-09-10?base=USD&symbols=INR')

    // the source now says something else; the date already held does not move
    ecb = () => json({ date: '2026-09-10', rates: { INR: 50 } })
    const again = await liveRate('USD', '2026-09-10', deps(new Date('2026-11-07T09:00:00Z')))   // a day later
    expect(again!.rate.toFixed(2)).toBe('95.44')
    expect(calls).toHaveLength(1)
    expect(await prisma.exchangeRate.count()).toBe(1)
  })

  it('a weekend keeps the date the source actually answered with', async () => {
    ecb = () => json({ date: '2026-11-06', rates: { INR: 94.3 } })
    const r = await liveRate('USD', '2026-11-08', deps(new Date('2026-11-09T09:00:00Z')))
    expect(r!.requested).toBe('2026-11-08')
    expect(r!.asOf).toBe('2026-11-06')
  })
})

describe('today', () => {
  it('uses the latest, holds it for half an hour, then asks again', async () => {
    const r = await liveRate('USD', undefined, deps())
    expect(r!.rate.toFixed(2)).toBe('94.48')
    expect(calls[0].url).toContain('/v1/latest?base=USD&symbols=INR')

    await liveRate('USD', undefined, deps(new Date(NOW.getTime() + 10 * 60_000)))
    expect(calls).toHaveLength(1)                         // ten minutes on: still held

    ecb = () => json({ date: '2026-11-06', rates: { INR: 94.91 } })
    const later = await liveRate('USD', undefined, deps(new Date(NOW.getTime() + 31 * 60_000)))
    expect(later!.rate.toFixed(2)).toBe('94.91')          // half an hour on: refreshed
    expect(await prisma.exchangeRate.count()).toBe(1)     // the same row, updated
  })

  it('a date in the future is today — nobody can be offered a rate that has not happened', async () => {
    const r = await liveRate('USD', '2027-01-01', deps())
    expect(r!.requested).toBe('2026-11-06')
  })
})

describe('when the first source has nothing', () => {
  it('🔴 falls back to the second for NOW, for a currency the ECB does not publish', async () => {
    ecb = () => json({ message: 'not found' }, 404)
    const r = await liveRate('AED', undefined, deps())
    expect(r!.source).toBe('open.er-api.com')
    expect(r!.rate.toFixed(2)).toBe('94.54')
  })

  it('🔴 never answers a PAST date from the second source, which only knows now', async () => {
    ecb = () => json({ message: 'not found' }, 404)
    expect(await liveRate('AED', '2026-09-10', deps())).toBeNull()
    expect(calls.some((c) => c.url.includes('er-api'))).toBe(false)
  })
})

describe('when nothing can be reached', () => {
  it('offers the last rate held for that date, marked stale', async () => {
    await liveRate('USD', undefined, deps())
    ecb = () => null; erApi = () => null
    const r = await liveRate('USD', undefined, deps(new Date(NOW.getTime() + 2 * 3_600_000)))
    expect(r!.stale).toBe(true)
    expect(r!.rate.toFixed(2)).toBe('94.48')
  })

  it('offers the latest held for the currency when the date itself was never fetched', async () => {
    await liveRate('USD', '2026-09-10', deps())
    ecb = () => null; erApi = () => null
    const r = await liveRate('USD', '2026-10-01', deps())
    expect(r!.stale).toBe(true)
    expect(r!.requested).toBe('2026-09-10')
  })

  it('and offers nothing — the person types it — when it holds nothing at all', async () => {
    ecb = () => null; erApi = () => null
    expect(await liveRate('USD', undefined, deps())).toBeNull()
  })
})

describe('what it refuses to believe', () => {
  it('rejects a zero, a negative, a non-number and an absurd rate', async () => {
    for (const bad of [0, -3, 'abc', 1e12, null]) {
      ecb = () => json({ date: '2026-11-05', rates: { INR: bad } })
      erApi = () => json({ result: 'success', rates: { INR: bad } })
      expect(await liveRate('USD', undefined, deps()), String(bad)).toBeNull()
    }
    expect(await prisma.exchangeRate.count()).toBe(0)
  })

  it('answers nothing for rupees or for a string that is not a currency code', async () => {
    expect(await liveRate('INR', undefined, deps())).toBeNull()
    expect(await liveRate('dollars', undefined, deps())).toBeNull()
    expect(await liveRate('US', undefined, deps())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('only a currency code and a date leave the server', async () => {
    await liveRate('USD', '2026-09-10', deps())
    for (const c of calls) expect(c.url).toMatch(/^https:\/\/(api\.frankfurter\.dev|open\.er-api\.com)\/[\w/.-]+(\?base=[A-Z]{3}&symbols=INR)?$/)
  })

  it('can be switched off, and then never touches the network', async () => {
    process.env.FX_LIVE_RATES = 'off'
    expect(await liveRate('USD', undefined, deps())).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
