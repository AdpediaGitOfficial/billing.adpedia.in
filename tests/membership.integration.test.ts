import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { listMembers, changeRole, setUserActive } from '@/server/services/auth/membership'
import { createInvitation, acceptInvitation } from '@/server/services/auth/invitation'
import { hashPassword } from '@/server/auth/password'
import type { RequestContext } from '@/server/context'

/** docs/77 — the way out, and the way to change somebody's mind about what they are. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', ownerId = ''

async function join(email: string, name: string, role: 'OWNER' | 'ACCOUNTANT' | 'EMPLOYEE' | 'AUDITOR') {
  const { token } = await createInvitation(ctx, { email, name, role })
  await acceptInvitation({ token, password: 'a-long-enough-password' })
  return prisma.user.findUniqueOrThrow({ where: { email } })
}

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const owner = await prisma.user.findFirstOrThrow()
  ctx = { userId: owner.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
  ownerId = owner.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 the last active owner', () => {
  it('cannot be demoted, because nobody would be left who can manage users', async () => {
    const members = await listMembers(ctx)
    expect(members.filter((m) => m.role === 'OWNER' && m.isActive)).toHaveLength(1)
    expect(members.find((m) => m.userId === ownerId)!.isLastOwner).toBe(true)

    // and from another owner's seat, so guard 2 is not what refuses it
    const second = await join('second-owner@example.com', 'Second Owner', 'OWNER')
    const asSecond: RequestContext = { ...ctx, userId: second.id }

    // now there are two, so the first is no longer the last
    expect((await listMembers(ctx)).find((m) => m.userId === ownerId)!.isLastOwner).toBe(false)
    await changeRole(asSecond, ownerId, 'ACCOUNTANT', 'Handing the company over')

    // which makes the second the only one — and now it refuses
    await expect(changeRole(ctx, second.id, 'EMPLOYEE', 'Trying to leave nobody in charge'))
      .rejects.toThrow(/only active owner/)
    await expect(setUserActive(ctx, second.id, false, 'Trying to leave nobody in charge'))
      .rejects.toThrow(/only active owner/)

    // put it back for the tests below
    await changeRole(asSecond, ownerId, 'OWNER', 'Restoring the original owner')
  })
})

/**
 * 🔴 Not because it is unsafe — the last-owner guard covers the lockout — but because it
 * cannot be satisfied honestly. A demotion takes effect on the next request, so the page it
 * was done from is the page that is then refused.
 */
describe('🔴 nobody changes their own membership', () => {
  it('refuses, and says to ask another owner', async () => {
    await expect(changeRole(ctx, ownerId, 'AUDITOR', 'Stepping back from the books'))
      .rejects.toThrow(/Ask another owner/)
    await expect(setUserActive(ctx, ownerId, false, 'Leaving the company'))
      .rejects.toThrow(/Ask another owner/)
  })
})

describe('changing a role', () => {
  it('demands a reason', async () => {
    const u = await join('pm@example.com', 'Project Lead', 'EMPLOYEE')
    await expect(changeRole(ctx, u.id, 'ACCOUNTANT', 'ok')).rejects.toThrow(/Say why/)
  })

  it('refuses a no-op', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'pm@example.com' } })
    await expect(changeRole(ctx, u.id, 'EMPLOYEE', 'No change at all')).rejects.toThrow(/already employee/)
  })

  it('records what it was before', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'pm@example.com' } })
    await changeRole(ctx, u.id, 'PROJECT_MANAGER', 'Taking over the Nuvé account')

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'UserCompany', action: 'UPDATE' }, orderBy: { at: 'desc' },
    })
    expect(JSON.stringify(log.before)).toContain('EMPLOYEE')
    expect(JSON.stringify(log.after)).toContain('PROJECT_MANAGER')
    expect(JSON.stringify(log.after)).toContain('Nuvé')
  })
})

describe('deactivating', () => {
  it('🔴 keeps the user row, because the audit log points at it', async () => {
    const u = await join('leaver@example.com', 'Someone Leaving', 'AUDITOR')
    await setUserActive(ctx, u.id, false, 'Contract ended on 30 September')

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { companies: true } })
    expect(after.isActive).toBe(false)
    // the membership stays too — the history has to keep resolving
    expect(after.companies).toHaveLength(1)
  })

  it('🔴 revokes the refresh tokens, so reactivating does not restore an old session', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'leaver@example.com' } })
    await prisma.refreshToken.create({
      data: { userId: u.id, familyId: 'f1', tokenHash: 'h1', expiresAt: new Date(Date.now() + 86_400_000) },
    })
    await setUserActive(ctx, u.id, true, 'Came back for the quarter')
    await setUserActive(ctx, u.id, false, 'Finished again')

    const live = await prisma.refreshToken.findMany({ where: { userId: u.id, revokedAt: null } })
    expect(live).toHaveLength(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).tokenVersion).toBeGreaterThan(0)
  })

  it('refuses a no-op', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'leaver@example.com' } })
    await expect(setUserActive(ctx, u.id, false, 'Already gone')).rejects.toThrow(/already deactivated/)
  })

  it('is refused to anybody without settings.users', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'pm@example.com' } })
    for (const role of ['ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR'] as const) {
      await expect(changeRole({ ...ctx, role }, u.id, 'OWNER', 'Promoting myself'))
        .rejects.toThrow()
      await expect(setUserActive({ ...ctx, role }, u.id, false, 'Removing a colleague'))
        .rejects.toThrow()
    }
  })
})

/**
 * 🔴 The role is read from the DATABASE on every request, not from the access token.
 *
 * It used to come from `claims.role`, so a demotion took effect only when the token was next
 * re-minted — up to fifteen minutes of owner rights after somebody had been made an employee,
 * across the 145 places that ask `ctx.role`.
 */
describe('🔴 a role change takes effect now', () => {
  it('is visible to getContext without re-issuing a token', async () => {
    const u = await prisma.user.create({
      data: { email: 'live-role@example.com', name: 'Live Role', passwordHash: await hashPassword('x'.repeat(14)) },
    })
    const m = await prisma.userCompany.create({ data: { userId: u.id, companyId, role: 'EMPLOYEE' } })

    await changeRole(ctx, u.id, 'ACCOUNTANT', 'Taking over the books')

    // what getContext would read, for a token minted while they were an EMPLOYEE
    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { companies: { where: { companyId }, select: { role: true } } },
    })
    expect(fresh.companies[0].role).toBe('ACCOUNTANT')
    expect(m.role).toBe('EMPLOYEE')
  })
})
