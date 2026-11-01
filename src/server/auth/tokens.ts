import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/server/db'
import { env } from '@/lib/env'

/**
 * Refresh tokens are opaque random bytes. Only their sha256 is stored, so a database
 * leak cannot be replayed. Every use rotates the token; reuse of an already-rotated
 * token revokes the whole family — that is the theft signal.
 */

export function newRefreshToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export async function issueRefreshToken(userId: string, familyId = randomUUID(), meta?: { ip?: string; userAgent?: string }) {
  const token = newRefreshToken()
  const expiresAt = new Date(Date.now() + env().REFRESH_TOKEN_TTL_SECONDS * 1000)
  await prisma.refreshToken.create({
    data: { userId, familyId, tokenHash: hashToken(token), expiresAt, ip: meta?.ip, userAgent: meta?.userAgent },
  })
  return { token, familyId, expiresAt }
}

export type RotateResult =
  | { ok: true; token: string; familyId: string; userId: string; expiresAt: Date }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'REUSE_DETECTED' | 'RACE' }

/**
 * 🔴 docs/83 — the window in which a second presentation is a RACE and not a theft.
 *
 * Reuse of a rotated token is the theft signal, and it revokes the whole family. But cookies
 * are shared between tabs, so two tabs whose keepalive fires in the same instant both read the
 * same cookie and both present it: one rotates, the other arrives at a row that was revoked
 * milliseconds ago. Treating that as theft would log the user out of every tab — and the
 * keepalive that makes a thirty-minute session possible would have been the thing that ended
 * it.
 *
 * Narrow on purpose: the row must have been replaced within this window AND its replacement
 * must still be live. A genuinely stolen token presented an hour later still burns the family,
 * which is the property this is here to keep.
 */
export const ROTATION_GRACE_MS = 15_000

type RevokedRow = { id: string; familyId: string; revokedAt: Date | null; replacedById: string | null }

/**
 * A rotated token presented a second time: a race between tabs, or the theft signal.
 *
 * 🔴 Narrow on purpose. The row must have been replaced INSIDE the window and its replacement
 * must still be live. A stolen token presented an hour later, or one whose successor has since
 * been revoked, still burns the family — that is the property the grace window must not spend.
 */
async function raceOrReuse(row: RevokedRow): Promise<RotateResult> {
  if (row.replacedById && row.revokedAt && Date.now() - row.revokedAt.getTime() <= ROTATION_GRACE_MS) {
    const successor = await prisma.refreshToken.findUnique({
      where: { id: row.replacedById }, select: { revokedAt: true },
    })
    // the winner's Set-Cookie has already put the successor in the jar both tabs share, so the
    // loser needs nothing done for it — and must not have the family pulled out from under it
    if (successor && !successor.revokedAt) return { ok: false, reason: 'RACE' }
  }
  await revokeFamily(row.familyId)
  return { ok: false, reason: 'REUSE_DETECTED' }
}

export async function rotateRefreshToken(presented: string, meta?: { ip?: string; userAgent?: string }): Promise<RotateResult> {
  const tokenHash = hashToken(presented)
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } })
  if (!row) return { ok: false, reason: 'NOT_FOUND' }
  if (row.revokedAt) return raceOrReuse(row)
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'EXPIRED' }

  const next = newRefreshToken()
  const expiresAt = new Date(Date.now() + env().REFRESH_TOKEN_TTL_SECONDS * 1000)

  /**
   * 🔴 The revocation CLAIMS the row, and it has to, or two tabs each rotate it once.
   *
   * This read the row, created a successor and then revoked the original. Two concurrent
   * requests both passed the `revokedAt` check above and both went on to create a successor:
   * two live tokens in one family, one of them in nobody's cookie jar — a credential nothing
   * would ever present or revoke — and a `replacedById` pointing at whichever write landed
   * second. Reuse detection cannot see any of that, because nothing was ever reused.
   *
   * `updateMany … WHERE revokedAt IS NULL` takes the row lock first, so the second transaction
   * waits, re-evaluates, matches nothing and knows it lost. Exactly one successor exists.
   */
  const rotated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    if (claimed.count === 0) return null

    const created = await tx.refreshToken.create({
      data: { userId: row.userId, familyId: row.familyId, tokenHash: hashToken(next), expiresAt, ip: meta?.ip, userAgent: meta?.userAgent },
    })
    await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: created.id } })
    return created
  })

  if (!rotated) {
    // somebody else claimed it while we were asking — re-read, because what decides between a
    // race and a theft is what they left behind
    const fresh = await prisma.refreshToken.findUniqueOrThrow({ where: { id: row.id } })
    return raceOrReuse(fresh)
  }

  return { ok: true, token: next, familyId: row.familyId, userId: row.userId, expiresAt }
}

export async function revokeFamily(familyId: string) {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Global revoke for one user — bumping tokenVersion also invalidates live access tokens. */
export async function revokeAllForUser(userId: string) {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
  ])
}
