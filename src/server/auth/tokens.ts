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
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'REUSE_DETECTED' }

export async function rotateRefreshToken(presented: string, meta?: { ip?: string; userAgent?: string }): Promise<RotateResult> {
  const tokenHash = hashToken(presented)
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } })
  if (!row) return { ok: false, reason: 'NOT_FOUND' }

  // Already rotated or revoked, yet presented again → the family is compromised.
  if (row.revokedAt) {
    await revokeFamily(row.familyId)
    return { ok: false, reason: 'REUSE_DETECTED' }
  }
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'EXPIRED' }

  const next = newRefreshToken()
  const expiresAt = new Date(Date.now() + env().REFRESH_TOKEN_TTL_SECONDS * 1000)

  await prisma.$transaction(async (tx) => {
    const created = await tx.refreshToken.create({
      data: { userId: row.userId, familyId: row.familyId, tokenHash: hashToken(next), expiresAt, ip: meta?.ip, userAgent: meta?.userAgent },
    })
    await tx.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), replacedById: created.id },
    })
  })

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
