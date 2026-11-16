import type { Role } from '@prisma/client'
import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'

/**
 * Who is on the company, and what they may do — docs/77.
 *
 * `docs/73` built the way in. This is the way out, and the way to change somebody's mind about
 * what they are — the two halves `docs/73 §7` left: *"both are one field and the same guard"*.
 * The field turned out to be one field. The guard turned out to be three.
 */

export interface Member {
  userId: string
  membershipId: string
  name: string
  email: string
  role: Role
  isActive: boolean
  lastLoginAt: Date | null
  /** 🔴 true when removing or demoting them would leave nobody who can administer the company */
  isLastOwner: boolean
  isSelf: boolean
}

export async function listMembers(ctx: RequestContext): Promise<Member[]> {
  assertCan(ctx.role, 'settings.users', 'read')

  const rows = await prisma.userCompany.findMany({
    where: { companyId: ctx.companyId },
    include: { user: { select: { id: true, name: true, email: true, isActive: true, lastLoginAt: true } } },
    orderBy: [{ role: 'asc' }],
  })

  const activeOwners = rows.filter((r) => r.role === 'OWNER' && r.user.isActive)

  return rows.map((r) => ({
    userId: r.user.id,
    membershipId: r.id,
    name: r.user.name,
    email: r.user.email,
    role: r.role,
    isActive: r.user.isActive,
    lastLoginAt: r.user.lastLoginAt,
    isLastOwner: r.role === 'OWNER' && r.user.isActive && activeOwners.length === 1,
    isSelf: r.user.id === ctx.userId,
  }))
}

/**
 * 🔴 The three guards, and why each one is here.
 *
 *   1. **The last active owner may not be demoted or deactivated.** `settings.users` is an
 *      owner-only capability, so removing the last one leaves a company nobody can administer
 *      and no way back except the database. A system that can lock its owner out has one
 *      failure mode that is worse than all the others.
 *   2. **Nobody may change their own membership.** Not because it is unsafe — guard 1 covers
 *      the lockout — but because it cannot be satisfied honestly: demoting yourself takes
 *      effect on the next request, so the page you did it from is the page you can no longer
 *      see. There is always another owner able to do it, by guard 1.
 *   3. **A reason, recorded.** The same rule as every other correction in this system. Who
 *      could see what, and from when, is the question an auditor asks about a period.
 */
async function loadTarget(ctx: RequestContext, userId: string) {
  const members = await listMembers(ctx)
  const target = members.find((m) => m.userId === userId)
  if (!target) throw new NotFound('That person is not on this company')
  if (target.isSelf) {
    throw new AppError(
      'You cannot change your own role or access — it would take effect on your next request, from a page ' +
      'you would no longer be able to see. Ask another owner.',
    )
  }
  return target
}

function requireReason(reason: string) {
  if (reason.trim().length < 5) {
    throw new AppError('Say why — it is read by whoever asks who could see what, and from when')
  }
}

export async function changeRole(ctx: RequestContext, userId: string, role: Role, reason: string) {
  assertCan(ctx.role, 'settings.users', 'write')
  requireReason(reason)

  const target = await loadTarget(ctx, userId)
  if (target.role === role) throw new AppError(`${target.name} is already ${role.replace('_', ' ').toLowerCase()}`)
  if (target.isLastOwner) {
    throw new AppError(
      `${target.name} is the only active owner. Make somebody else an owner first — otherwise nobody is left ` +
      'who can manage users, company details or the year-end close.',
    )
  }

  const updated = await prisma.userCompany.update({
    where: { companyId: ctx.companyId, id: target.membershipId },
    data: { role },
  })

  await audit(ctx, {
    entity: 'UserCompany', entityId: target.membershipId, action: 'UPDATE',
    before: { user: target.email, role: target.role },
    after: { role, reason: reason.trim() },
  })
  return updated
}

/**
 * Deactivate — which is what "removing somebody" means here.
 *
 * 🔴 The user row is never deleted. Every audit entry, every journal entry and every document
 * points at a user id that has to keep resolving; a deleted user turns a year of history into
 * rows attributed to nobody. `isActive` is checked on every request (`getContext`), so this
 * takes effect immediately rather than at the next token refresh.
 */
export async function setUserActive(ctx: RequestContext, userId: string, active: boolean, reason: string) {
  assertCan(ctx.role, 'settings.users', 'write')
  requireReason(reason)

  const target = await loadTarget(ctx, userId)
  if (target.isActive === active) {
    throw new AppError(`${target.name} is already ${active ? 'active' : 'deactivated'}`)
  }
  if (!active && target.isLastOwner) {
    throw new AppError(
      `${target.name} is the only active owner. Deactivating them would leave nobody who can manage users, ` +
      'company details or the year-end close.',
    )
  }

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: target.userId },
      data: active
        ? { isActive: true }
        /**
         * 🔴 Deactivating revokes the refresh tokens too, and bumps `tokenVersion`.
         *
         * `isActive` already ends access on the next request, so this is belt and braces for
         * one case that matters: a refresh token lives for days, and reactivating somebody
         * later must not silently restore a session they held before they were removed.
         */
        : { isActive: false, tokenVersion: { increment: 1 } },
    })
    if (!active) {
      await tx.refreshToken.updateMany({
        where: { userId: target.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
    return u
  })

  await audit(ctx, {
    entity: 'User', entityId: target.userId, action: active ? 'UPDATE' : 'CANCEL',
    before: { user: target.email, isActive: target.isActive },
    after: { isActive: active, reason: reason.trim() },
  })
  return user
}
