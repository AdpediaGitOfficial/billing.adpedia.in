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
    select: { tokenVersion: true, isActive: true },
  })
  if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion) return null

  return { userId: claims.sub, companyId: claims.companyId, role: claims.role }
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
