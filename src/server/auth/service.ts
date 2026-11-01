import { cookies } from 'next/headers'
import { prisma } from '@/server/db'
import { env } from '@/lib/env'
import { verifyPassword } from './password'
import { signAccessToken } from './jwt'
import { issueRefreshToken, rotateRefreshToken, revokeFamily, hashToken } from './tokens'
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/server/context'
import { Unauthorized } from '@/server/errors'
import { chooseCompany } from './company-choice'

const baseCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

async function setAuthCookies(accessToken: string, refreshToken: string) {
  const jar = await cookies()
  jar.set(ACCESS_COOKIE, accessToken, { ...baseCookie, maxAge: env().ACCESS_TOKEN_TTL_SECONDS })
  jar.set(REFRESH_COOKIE, refreshToken, { ...baseCookie, maxAge: env().REFRESH_TOKEN_TTL_SECONDS, path: '/api/auth' })
}

/**
 * Replace just the access token — docs/82 §3's switcher.
 *
 * 🔴 `companyId` is a CLAIM, so moving between entities means a newly signed token, not a
 * database flag the app reads later. The refresh token is untouched: the session is the same
 * session, in different books.
 *
 * Exported rather than rebuilt at the call site because `baseCookie` carries the `secure` flag,
 * and a switcher that quietly dropped it would hand the session cookie to the network.
 */
export async function setAccessCookie(accessToken: string) {
  const jar = await cookies()
  jar.set(ACCESS_COOKIE, accessToken, { ...baseCookie, maxAge: env().ACCESS_TOKEN_TTL_SECONDS })
}

export async function clearAuthCookies() {
  const jar = await cookies()
  jar.set(ACCESS_COOKIE, '', { ...baseCookie, maxAge: 0 })
  jar.set(REFRESH_COOKIE, '', { ...baseCookie, maxAge: 0, path: '/api/auth' })
}

export async function login(email: string, password: string, meta?: { ip?: string; userAgent?: string }) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { companies: { include: { company: { select: { id: true, legalName: true } } } } },
  })

  // Constant-ish work whether or not the user exists, so timing does not leak membership.
  const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', password)
  if (!user || !ok || !user.isActive) throw new Unauthorized('Incorrect email or password')

  // 🔴 docs/82 §3 — not `companies[0]`. See `company-choice.ts` for why that was a bug
  // waiting for a second membership.
  const membership = chooseCompany(user.companies, user.lastCompanyId)
  if (!membership) throw new Unauthorized('This account is not linked to a company')

  const accessToken = await signAccessToken({
    sub: user.id, companyId: membership.companyId, role: membership.role, tokenVersion: user.tokenVersion,
  })
  const { token: refreshToken } = await issueRefreshToken(user.id, undefined, meta)
  await setAuthCookies(accessToken, refreshToken)
  await prisma.user.update({
    where: { id: user.id },
    // the entity this session is in becomes a recorded fact, so a refresh cannot move it
    data: { lastLoginAt: new Date(), lastCompanyId: membership.companyId },
  })

  return {
    user: { id: user.id, name: user.name, email: user.email },
    company: membership.company,
    role: membership.role,
  }
}

export async function refresh(meta?: { ip?: string; userAgent?: string }) {
  const jar = await cookies()
  const presented = jar.get(REFRESH_COOKIE)?.value
  if (!presented) throw new Unauthorized('No refresh token')

  const result = await rotateRefreshToken(presented, meta)
  // 🔴 a race is not a failure and must not clear anything: the tab that won has already
  // refreshed this session's cookies, and both tabs share them
  if (!result.ok && result.reason === 'RACE') return { ok: true, raced: true }
  if (!result.ok) {
    await clearAuthCookies()
    // Reuse of an already-rotated token means the family is compromised; rotateRefreshToken
    // has already revoked it. Say nothing more specific to the caller.
    throw new Unauthorized(result.reason === 'REUSE_DETECTED' ? 'Session revoked — please sign in again' : 'Session expired')
  }

  const user = await prisma.user.findUnique({
    where: { id: result.userId },
    include: { companies: { include: { company: { select: { legalName: true } } } } },
  })
  if (!user || !user.isActive) {
    await clearAuthCookies()
    throw new Unauthorized()
  }

  /**
   * 🔴 A refresh must land in the SAME entity the session was already in — docs/82 §3.
   *
   * This read `user.companies[0]`, so with two memberships a routine fifteen-minute refresh
   * could change which company the session was writing to, silently and mid-task. Nothing in
   * the UI would have said so, and an invoice drafted before the refresh would have posted to
   * the other entity's books.
   */
  const membership = chooseCompany(user.companies, user.lastCompanyId)
  if (!membership) {
    await clearAuthCookies()
    throw new Unauthorized()
  }

  const accessToken = await signAccessToken({
    sub: user.id, companyId: membership.companyId, role: membership.role, tokenVersion: user.tokenVersion,
  })
  await setAuthCookies(accessToken, result.token)
  return { ok: true, raced: false }
}

export async function logout() {
  const jar = await cookies()
  const presented = jar.get(REFRESH_COOKIE)?.value
  if (presented) {
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } })
    if (row) await revokeFamily(row.familyId)
  }
  await clearAuthCookies()
}
