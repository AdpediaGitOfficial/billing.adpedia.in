import { cookies, headers } from 'next/headers'
import type { Role } from '@prisma/client'
import { verifyAccessToken } from '@/server/auth/jwt'
import { prisma } from '@/server/db'
import { Unauthorized } from '@/server/errors'

export const ACCESS_COOKIE = 'adp_at'
export const REFRESH_COOKIE = 'adp_rt'

export interface RequestContext {
  userId: string
  /** 🔴 The multi-company isolation boundary. Always from the token, never from a request body. */
  companyId: string
  role: Role
}

export async function getContext(): Promise<RequestContext | null> {
  const jar = await cookies()
  const token = jar.get(ACCESS_COOKIE)?.value
  if (!token) return null

  const claims = await verifyAccessToken(token)
  if (!claims) return null

  // tokenVersion lets one integer bump invalidate every live token for a user.
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      tokenVersion: true, isActive: true,
      // 🔴 docs/77 — the ROLE comes from here, not from the token.
      //
      // It was read from `claims.role`, so a demotion took effect only when the access token
      // was next re-minted: up to ACCESS_TOKEN_TTL_SECONDS — fifteen minutes — of owner rights
      // after somebody had been made an employee, across the 145 places that ask `ctx.role`.
      // The query was already running on every request; this is one more column on it.
      //
      // The claim is still signed, so tokens issued before this change keep working. It must
      // never be read again: a claim that is authoritative in one place and stale in another
      // is the "two balances with the same name" of docs/56 §2.
      companies: {
        where: { companyId: claims.companyId },
        select: { role: true },
        take: 1,
      },
    },
  })
  if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion) return null

  // 🔴 and no membership is no access. Removing somebody from the company ends their session
  // on the next request, without waiting for a token to expire.
  const membership = user.companies[0]
  if (!membership) return null

  return { userId: claims.sub, companyId: claims.companyId, role: membership.role }
}

export async function requireContext(): Promise<RequestContext> {
  const ctx = await getContext()
  if (!ctx) throw new Unauthorized()
  return ctx
}

export async function clientMeta() {
  const h = await headers()
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    userAgent: h.get('user-agent') ?? undefined,
  }
}
