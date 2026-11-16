import { randomBytes } from 'node:crypto'
import type { Role } from '@prisma/client'
import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { hashToken } from '@/server/auth/tokens'
import { hashPassword } from '@/server/auth/password'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'

/**
 * Invitations — docs/73.
 *
 * 🔴 An invitation is a credential, and everything here follows from that.
 *
 *   · The token is 32 random bytes and only its sha256 is stored, exactly like the refresh
 *     tokens in `auth/tokens.ts`. A database leak cannot be replayed, and nobody — including
 *     the owner who sent it — can read it back. It is shown once, at creation.
 *   · It expires, and it is single-use.
 *   · 🔴 **Accepting it does not create a session.** A link in an email that signs you in IS a
 *     password: forwarded, logged by a proxy, and sitting in a mailbox for years. Accepting
 *     sets a password and stops there; the person then signs in like anybody else.
 *   · The role is fixed by the inviter. The invitee supplies a password and nothing else.
 *
 * 🔴 Nothing is emailed. This system has no mailer and `docs/61 §1` settled why: a message
 * that matters goes from a person's own address, under their own name. The owner gets a link
 * and sends it the way they would send anything else.
 */

const TTL_DAYS = 7
const MIN_PASSWORD = 12

export async function createInvitation(ctx: RequestContext, input: {
  email: string
  name: string
  role: Role
}) {
  assertCan(ctx.role, 'settings.users', 'write')

  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('That is not an email address')
  if (name.length < 2) throw new AppError('Give the person a name — it is what appears in the audit log')

  /**
   * 🔴 Refusing by name is safe HERE and only here. The inviter can already read every
   * membership on /settings/users, so saying "they are already on the list" leaks nothing —
   * whereas the public acceptance page, which anybody can reach, must never distinguish one
   * failure from another.
   */
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { companies: { where: { companyId: ctx.companyId } } },
  })
  if (existing?.companies.length) {
    throw new AppError(`${email} is already on this company — change their role on the users page instead`)
  }
  if (existing) {
    throw new AppError(
      `${email} already has an account on this system. Inviting them again would ask them to set a new ` +
      'password, which is not something an invitation should be able to do — add them to the company directly.',
    )
  }

  const open = await prisma.invitation.findFirst({
    where: { companyId: ctx.companyId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  })
  if (open) {
    throw new AppError(`${email} already has an invitation open until ${open.expiresAt.toISOString().slice(0, 10)} — revoke it first to issue another`)
  }

  const token = randomBytes(32).toString('base64url')
  const invitation = await prisma.invitation.create({
    data: {
      companyId: ctx.companyId, email, name, role: input.role,
      tokenHash: hashToken(token),
      invitedById: ctx.userId,
      expiresAt: new Date(Date.now() + TTL_DAYS * 86_400_000),
    },
  })

  // 🔴 the token is NOT in the audit log. It is a credential, and the log is read by people
  await audit(ctx, {
    entity: 'Invitation', entityId: invitation.id, action: 'CREATE',
    after: { email, role: input.role, expiresAt: invitation.expiresAt.toISOString().slice(0, 10) },
  })

  /** The plaintext, returned once and never recoverable. */
  return { invitation, token }
}

export async function listInvitations(ctx: RequestContext) {
  assertCan(ctx.role, 'settings.users', 'read')
  return prisma.invitation.findMany({
    where: { companyId: ctx.companyId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function revokeInvitation(ctx: RequestContext, id: string, reason: string) {
  assertCan(ctx.role, 'settings.users', 'write')
  if (reason.trim().length < 5) throw new AppError('Say why it is being revoked — "ok" is not a reason')

  const invitation = await prisma.invitation.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!invitation) throw new NotFound('Invitation not found')
  if (invitation.acceptedAt) throw new AppError('That invitation has already been accepted — deactivate the user instead')
  if (invitation.revokedAt) throw new AppError('That invitation is already revoked')

  const revoked = await prisma.invitation.update({
    where: { id: invitation.id, companyId: ctx.companyId },
    data: { revokedAt: new Date(), revokeReason: reason.trim() },
  })
  await audit(ctx, {
    entity: 'Invitation', entityId: invitation.id, action: 'CANCEL',
    before: { email: invitation.email, role: invitation.role },
    after: { reason: reason.trim() },
  })
  return revoked
}

/* ── the public half ─────────────────────────────────────────────────────────── */

export interface InviteeView {
  name: string
  email: string
  role: Role
  companyName: string
}

/**
 * What the acceptance page may show, for a token that is good.
 *
 * 🔴 `null` for every other case, without distinguishing them. Unknown, expired, revoked and
 * already-accepted all look identical from outside — anything else turns this page into an
 * oracle for whether a given token ever existed, and whether an invitation is still live.
 */
export async function inviteeFor(token: string): Promise<InviteeView | null> {
  if (!token) return null
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { company: { select: { legalName: true, tradeName: true } } },
  })
  if (!invitation) return null
  if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) return null

  return {
    name: invitation.name,
    email: invitation.email,
    role: invitation.role,
    companyName: invitation.company.tradeName ?? invitation.company.legalName,
  }
}

/**
 * Accept it: create the user, give them the membership the inviter chose, and stop.
 *
 * 🔴 No session is created and nothing is returned that could be used as one. The caller
 * redirects to /login, and the person signs in with the password they have just set.
 */
export async function acceptInvitation(input: { token: string; password: string }) {
  const password = input.password ?? ''
  if (password.length < MIN_PASSWORD) {
    throw new AppError(`Choose a password of at least ${MIN_PASSWORD} characters`)
  }

  const tokenHash = hashToken(input.token ?? '')
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash } })
  // the same refusal for every reason — see `inviteeFor`
  const bad = new AppError('That invitation link is not valid. Ask whoever invited you for a new one.')
  if (!invitation) throw bad
  if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) throw bad

  const passwordHash = await hashPassword(password)

  return prisma.$transaction(async (tx) => {
    /**
     * 🔴 Claim the invitation FIRST, conditionally.
     *
     * `updateMany` with `acceptedAt: null` in the where clause is the claim: two submissions
     * racing — a double-click, a retried POST — both find an unaccepted invitation if they
     * read before either writes, and would then both create a user. The second update matches
     * nothing and loses, which is the same discipline the offline queue uses in `docs/30 §1`.
     */
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    })
    if (claimed.count !== 1) throw bad

    const user = await tx.user.create({
      data: { email: invitation.email, name: invitation.name, passwordHash, isActive: true },
    })
    await tx.userCompany.create({
      data: { userId: user.id, companyId: invitation.companyId, role: invitation.role },
    })
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedUserId: user.id } })

    await audit(
      { userId: user.id, companyId: invitation.companyId },
      {
        entity: 'Invitation', entityId: invitation.id, action: 'UPDATE',
        after: { accepted: invitation.email, role: invitation.role },
      },
      tx,
    )

    return { email: user.email }
  })
}
