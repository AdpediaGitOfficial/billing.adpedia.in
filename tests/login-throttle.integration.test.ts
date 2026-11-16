import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'

// `login` writes cookies through next/headers, which needs a request. A plain jar stands in.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => { jar.set(k, v) },
  }),
  headers: async () => new Headers(),
}))

import { login } from '@/server/auth/service'
import { MAX_FAILURES, LOCK_MS, WINDOW_MS, assertNotLocked, recordFailure } from '@/server/auth/throttle'
import { TooManyAttempts, Unauthorized } from '@/server/errors'

/**
 * docs/95 — `/api/auth/login` had no limit at all.
 */
const prisma = new PrismaClient()
const EMAIL = 'test@adpedia.local'

beforeAll(async () => { await resetDb(prisma) })
beforeEach(async () => { jar.clear(); await prisma.loginThrottle.deleteMany() })
afterAll(async () => { await prisma.$disconnect() })

const wrong = (email = EMAIL) => login(email, 'not-the-password')

describe('🔴 failed sign-ins lock the address', () => {
  it('answers an ordinary wrong password as before, up to the limit', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(wrong()).rejects.toBeInstanceOf(Unauthorized)
    }
  })

  it('🔴 locks on the next attempt — and refuses the CORRECT password too', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await wrong().catch(() => {})
    await expect(wrong()).rejects.toBeInstanceOf(TooManyAttempts)
    await expect(login(EMAIL, 'test')).rejects.toBeInstanceOf(TooManyAttempts)
    expect(jar.size).toBe(0)   // no cookie was issued to the guesser
  })

  it('says how long to wait', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await wrong().catch(() => {})
    const e = await wrong().catch((x) => x) as TooManyAttempts
    expect(e.status).toBe(429)
    expect(e.retryAfterSeconds).toBeGreaterThan(0)
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(LOCK_MS / 1000)
  })

  it('🔴 counts an address that is NOT an account, so the lock does not reveal which are', async () => {
    const ghost = 'nobody@example.com'
    for (let i = 0; i < MAX_FAILURES; i++) await wrong(ghost).catch(() => {})
    await expect(wrong(ghost)).rejects.toBeInstanceOf(TooManyAttempts)
  })

  it('treats the same address in another case as the same address', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await wrong('TEST@Adpedia.Local ').catch(() => {})
    await expect(wrong()).rejects.toBeInstanceOf(TooManyAttempts)
  })

  it('a good sign-in forgets the failures before it', async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await wrong().catch(() => {})
    await login(EMAIL, 'test')
    expect(await prisma.loginThrottle.count()).toBe(0)
    // seven more is still under the limit, because the count started again
    for (let i = 0; i < MAX_FAILURES - 1; i++) await expect(wrong()).rejects.toBeInstanceOf(Unauthorized)
  })

  it('a different address is unaffected by the lock', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await wrong().catch(() => {})
    await expect(wrong('someone.else@example.com')).rejects.toBeInstanceOf(Unauthorized)
  })
})

describe('the window and the lock expire', () => {
  it('the lock ends after LOCK_MS', async () => {
    const t0 = new Date('2026-11-16T10:00:00Z')
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure(EMAIL, t0)
    await expect(assertNotLocked(EMAIL, new Date(t0.getTime() + LOCK_MS - 1000))).rejects.toBeInstanceOf(TooManyAttempts)
    await expect(assertNotLocked(EMAIL, new Date(t0.getTime() + LOCK_MS + 1000))).resolves.toBeUndefined()
  })

  it('failures older than the window do not add up', async () => {
    const t0 = new Date('2026-11-16T10:00:00Z')
    for (let i = 0; i < MAX_FAILURES - 1; i++) await recordFailure(EMAIL, t0)
    // one more, after the window: the count restarts at one instead of reaching the limit
    const later = new Date(t0.getTime() + WINDOW_MS + 1000)
    await recordFailure(EMAIL, later)
    await expect(assertNotLocked(EMAIL, later)).resolves.toBeUndefined()
    const row = await prisma.loginThrottle.findUniqueOrThrow({ where: { key: EMAIL } })
    expect(row.failures).toBe(1)
  })

  it('🔴 parallel failures are all counted — none is lost to a read-then-write race', async () => {
    const t0 = new Date('2026-11-16T10:00:00Z')
    await Promise.all(Array.from({ length: MAX_FAILURES }, () => recordFailure(EMAIL, t0)))
    const row = await prisma.loginThrottle.findUniqueOrThrow({ where: { key: EMAIL } })
    expect(row.failures).toBe(MAX_FAILURES)
    expect(row.lockedUntil).not.toBeNull()
  })

  it('stale rows are swept', async () => {
    const old = new Date('2026-11-10T10:00:00Z')
    await recordFailure('old@example.com', old)
    await recordFailure(EMAIL, new Date('2026-11-16T10:00:00Z'))
    expect(await prisma.loginThrottle.count({ where: { key: 'old@example.com' } })).toBe(0)
  })
})
