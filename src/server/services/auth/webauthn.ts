import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server'
import { prisma } from '@/server/db'
import { AppError } from '@/server/errors'
import type { RequestContext } from '@/server/context'

/**
 * Passkey re-authentication.
 *
 * 🔴 This is a SECOND factor over an existing session, not a way in. A passkey never
 * creates a session and never replaces the password — it only re-proves that the person
 * holding an already-authenticated session is still the one who opened it, after the app
 * has been idle. If passkeys are unavailable or fail, the fallback is the password, never
 * "let them through".
 */

const CHALLENGE_TTL_MS = 5 * 60_000

/**
 * The relying party ID must be the registered domain, and the origin must match exactly.
 * Getting these wrong is the classic WebAuthn deployment bug: assertions verify locally
 * and fail in production, or — worse — a permissive origin check accepts an assertion
 * generated for another site.
 */
function rp() {
  const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000'
  const rpID = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname
  return { origin, rpID, rpName: 'Adpedia Finance' }
}

async function putChallenge(userId: string, challenge: string, purpose: 'REGISTER' | 'AUTH') {
  // one live challenge per purpose — issuing a new one invalidates the old
  await prisma.webauthnChallenge.deleteMany({ where: { userId, purpose } })
  await prisma.webauthnChallenge.create({
    data: { userId, challenge, purpose, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  })
}

/** Single use: taken and deleted in one step so a replay finds nothing. */
async function takeChallenge(userId: string, purpose: 'REGISTER' | 'AUTH'): Promise<string> {
  const row = await prisma.webauthnChallenge.findFirst({
    where: { userId, purpose }, orderBy: { createdAt: 'desc' },
  })
  if (!row) throw new AppError('No challenge in progress — start again')
  await prisma.webauthnChallenge.delete({ where: { id: row.id } })
  if (row.expiresAt < new Date()) throw new AppError('That took too long — start again')
  return row.challenge
}

export async function registrationOptions(ctx: RequestContext) {
  const { rpID, rpName } = rp()
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { id: true, email: true, name: true, passkeys: { select: { credentialId: true, transports: true } } },
  })

  const options = await generateRegistrationOptions({
    rpName, rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    // stop the same authenticator being enrolled twice — it just confuses the user
    excludeCredentials: user.passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      // 🔴 the whole point is proving a PERSON is present, so a mere possession check
      // of an unlocked device is not enough
      userVerification: 'required',
    },
  })

  await putChallenge(user.id, options.challenge, 'REGISTER')
  return options
}

type AuthenticatorTransportFuture = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'

export async function verifyRegistration(ctx: RequestContext, response: RegistrationResponseJSON, label?: string) {
  const { origin, rpID } = rp()
  const expectedChallenge = await takeChallenge(ctx.userId, 'REGISTER')

  const verification = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: true,
  })
  if (!verification.verified || !verification.registrationInfo) {
    throw new AppError('That passkey could not be verified')
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
  await prisma.passkey.create({
    data: {
      userId: ctx.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      label: label ?? 'This device',
    },
  })
  return { ok: true }
}

export async function authenticationOptions(ctx: RequestContext) {
  const { rpID } = rp()
  const passkeys = await prisma.passkey.findMany({
    where: { userId: ctx.userId }, select: { credentialId: true, transports: true },
  })
  if (passkeys.length === 0) throw new AppError('No passkey registered on this account')

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: 'required',
  })

  await putChallenge(ctx.userId, options.challenge, 'AUTH')
  return options
}

export async function verifyAuthentication(ctx: RequestContext, response: AuthenticationResponseJSON) {
  const { origin, rpID } = rp()
  const expectedChallenge = await takeChallenge(ctx.userId, 'AUTH')

  const passkey = await prisma.passkey.findUnique({ where: { credentialId: response.id } })
  // the credential must belong to THIS session's user — otherwise anyone with a valid
  // passkey could unlock anyone else's idle session
  if (!passkey || passkey.userId !== ctx.userId) throw new AppError('Unknown passkey')

  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: Number(passkey.counter),
      transports: passkey.transports as AuthenticatorTransportFuture[],
    },
  })
  if (!verification.verified) throw new AppError('That did not match')

  // 🔴 A counter that did not advance means the credential was cloned. Authenticators that
  // report 0 throughout are legitimate (most platform ones do), so only a NON-ZERO counter
  // that failed to increase is treated as a clone.
  const newCounter = BigInt(verification.authenticationInfo.newCounter)
  if (passkey.counter > BigInt(0) && newCounter <= passkey.counter) {
    throw new AppError('This passkey looks cloned — re-authenticate with your password')
  }

  await prisma.passkey.update({
    where: { id: passkey.id },
    data: { counter: newCounter, lastUsedAt: new Date() },
  })
  return { ok: true }
}

export async function listPasskeys(ctx: RequestContext) {
  return prisma.passkey.findMany({
    where: { userId: ctx.userId },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, deviceType: true, backedUp: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function deletePasskey(ctx: RequestContext, id: string) {
  const { count } = await prisma.passkey.deleteMany({ where: { id, userId: ctx.userId } })
  if (count === 0) throw new AppError('Passkey not found')
  return { ok: true }
}
