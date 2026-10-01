import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { env } from '@/lib/env'
import type { Role } from '@prisma/client'

export interface AccessClaims extends JWTPayload {
  sub: string          // userId
  companyId: string
  role: Role
  tokenVersion: number
}

function secret() {
  return new TextEncoder().encode(env().JWT_SECRET)
}

export interface AccessTokenInput {
  sub: string
  companyId: string
  role: Role
  tokenVersion: number
}

// NB: JWTPayload has a string index signature, so Omit<AccessClaims, keyof JWTPayload>
// erases every field. Hence the explicit input type above.
export async function signAccessToken(claims: AccessTokenInput) {
  const ttl = env().ACCESS_TOKEN_TTL_SECONDS
  return new SignJWT({ companyId: claims.companyId, role: claims.role, tokenVersion: claims.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('adpedia-erp')
    .setExpirationTime(`${ttl}s`)
    .sign(secret())
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: 'adpedia-erp' })
    if (!payload.sub || !payload.companyId || !payload.role) return null
    return payload as AccessClaims
  } catch {
    return null
  }
}
