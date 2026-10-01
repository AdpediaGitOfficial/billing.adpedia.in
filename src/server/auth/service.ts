import { cookies } from 'next/headers'
import { prisma } from '@/server/db'
import { env } from '@/lib/env'
import { verifyPassword } from './password'
import { signAccessToken } from './jwt'
import { issueRefreshToken, rotateRefreshToken, revokeFamily, hashToken } from './tokens'
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/server/context'
import { Unauthorized } from '@/server/errors'

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

  const membership = user.companies[0]
  if (!membership) throw new Unauthorized('This account is not linked to a company')

  const accessToken = await signAccessToken({
    sub: user.id, companyId: membership.companyId, role: membership.role, tokenVersion: user.tokenVersion,
  })
  const { token: refreshToken } = await issueRefreshToken(user.id, undefined, meta)
  await setAuthCookies(accessToken, refreshToken)
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

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
  if (!result.ok) {
    await clearAuthCookies()
    // Reuse of an already-rotated token means the family is compromised; rotateRefreshToken
    // has already revoked it. Say nothing more specific to the caller.
    throw new Unauthorized(result.reason === 'REUSE_DETECTED' ? 'Session revoked — please sign in again' : 'Session expired')
  }

  const user = await prisma.user.findUnique({
    where: { id: result.userId },
    include: { companies: true },
  })
  if (!user || !user.isActive || !user.companies[0]) {
    await clearAuthCookies()
    throw new Unauthorized()
  }

  const accessToken = await signAccessToken({
    sub: user.id, companyId: user.companies[0].companyId, role: user.companies[0].role, tokenVersion: user.tokenVersion,
  })
  await setAuthCookies(accessToken, result.token)
  return { ok: true }
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
