import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import {
  issueRefreshToken, rotateRefreshToken, hashToken, ROTATION_GRACE_MS,
} from '@/server/auth/tokens'

/**
 * docs/83 — the session that ended after fifteen minutes, and the lockout that fixing it
 * nearly caused.
 *
 * 🔴 `/api/auth/refresh` existed with rotating tokens, reuse detection and a thirty-day
 * lifetime, and nothing in the application ever called it. The access cookie carries
 * `maxAge: ACCESS_TOKEN_TTL_SECONDS`, so it expired at fifteen minutes, the middleware saw no
 * token, and the user was redirected to `/login` mid-task.
 *
 * 🔴 And calling it from a timer in every tab would have been worse. Cookies are shared, so two
 * tabs firing together present the same token: one rotates it, the other arrives at a row
 * revoked milliseconds ago — which is the theft signal, and it revokes the whole family. The
 * keepalive that makes a long session possible would have been the thing that ended it.
 */

const prisma = new PrismaClient()
let userId = ''

beforeAll(async () => {
  await resetDb(prisma)
  userId = (await prisma.user.findFirstOrThrow()).id
})
afterAll(async () => { await prisma.$disconnect() })

const live = (familyId: string) =>
  prisma.refreshToken.count({ where: { familyId, revokedAt: null } })

describe('🔴 two tabs refreshing at once', () => {
  it('rotates for the first', async () => {
    const { token, familyId } = await issueRefreshToken(userId)
    const first = await rotateRefreshToken(token)
    expect(first.ok).toBe(true)
    expect(await live(familyId)).toBe(1)
  })

  /**
   * 🔴 The race, and the reason it must not look like theft: the tab that lost has nothing to
   * do, because the winner's `Set-Cookie` has already put the new token in the jar they share.
   */
  it('🔴 tells the second it raced, and leaves the session alone', async () => {
    const { token, familyId } = await issueRefreshToken(userId)
    const [a, b] = await Promise.all([rotateRefreshToken(token), rotateRefreshToken(token)])

    const outcomes = [a, b].map((r) => (r.ok ? 'ROTATED' : r.reason)).sort()
    expect(outcomes).toEqual(['RACE', 'ROTATED'])
    // 🔴 the family survives, which is the whole point
    expect(await live(familyId)).toBe(1)

    /**
     * 🔴 And exactly ONE successor exists. Before the revocation claimed the row, both
     * requests passed the revoked check and both created one: two live tokens, one of them in
     * nobody's cookie jar — a credential nothing would ever present, and nothing would ever
     * revoke. Reuse detection could not see it, because nothing was reused.
     */
    expect(await prisma.refreshToken.count({ where: { familyId } }),
      'one original and one successor, no orphan').toBe(2)
  })

  /**
   * 🔴 And the property the grace window must NOT give away. An old token presented after the
   * window is the theft signal it always was, and it burns the family.
   */
  it('🔴 still burns the family for a token presented after the window', async () => {
    const { token, familyId } = await issueRefreshToken(userId)
    await rotateRefreshToken(token)

    // age the revocation past the window, which is what a stolen token looks like
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(token) },
      data: { revokedAt: new Date(Date.now() - ROTATION_GRACE_MS - 1000) },
    })

    const reused = await rotateRefreshToken(token)
    expect(reused.ok).toBe(false)
    expect(reused.ok === false && reused.reason).toBe('REUSE_DETECTED')
    expect(await live(familyId), 'every token in the family should be revoked').toBe(0)
  })

  it('and a race is not a way back in once the successor is itself revoked', async () => {
    const { token, familyId } = await issueRefreshToken(userId)
    await rotateRefreshToken(token)
    // the successor is gone — a sign-out, or the family burned elsewhere
    await prisma.refreshToken.updateMany({ where: { familyId }, data: { revokedAt: new Date() } })

    const again = await rotateRefreshToken(token)
    expect(again.ok === false && again.reason).toBe('REUSE_DETECTED')
  })

  it('a token nobody issued is not found, and takes no family with it', async () => {
    const r = await rotateRefreshToken('not-a-token-anybody-issued')
    expect(r.ok === false && r.reason).toBe('NOT_FOUND')
  })

  it('an expired token is expired rather than suspicious', async () => {
    const { token } = await issueRefreshToken(userId)
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const r = await rotateRefreshToken(token)
    expect(r.ok === false && r.reason).toBe('EXPIRED')
  })

  it('the window is short enough to be a race and not a session', () => {
    expect(ROTATION_GRACE_MS).toBeLessThanOrEqual(60_000)
    expect(ROTATION_GRACE_MS).toBeGreaterThan(0)
  })
})
