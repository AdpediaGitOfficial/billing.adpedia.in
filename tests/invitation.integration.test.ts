import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import {
  createInvitation, listInvitations, revokeInvitation, inviteeFor, acceptInvitation,
} from '@/server/services/auth/invitation'
import { hashToken } from '@/server/auth/tokens'
import { verifyPassword } from '@/server/auth/password'
import type { RequestContext } from '@/server/context'

/** docs/73 — an invitation is a credential, and is held like one. */

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 the token is a credential', () => {
  it('is never stored in plaintext, and is returned once', async () => {
    const { invitation, token } = await createInvitation(ctx, {
      email: 'Priya@Example.com', name: 'Priya Nair', role: 'ACCOUNTANT',
    })
    expect(token).toHaveLength(43)                       // 32 random bytes, base64url
    expect(invitation.tokenHash).toBe(hashToken(token))

    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })
    expect(JSON.stringify(stored)).not.toContain(token)
    // and the email is normalised, so a second invite to the same person is recognised
    expect(stored.email).toBe('priya@example.com')
  })

  it('🔴 is not written to the audit log either, which people read', async () => {
    const { invitation, token } = await createInvitation(ctx, {
      email: 'deepak@example.com', name: 'Deepak R', role: 'EMPLOYEE',
    })
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Invitation', entityId: invitation.id, action: 'CREATE' },
    })
    expect(JSON.stringify(log)).not.toContain(token)
    expect(JSON.stringify(log.after)).toContain('deepak@example.com')
  })
})

describe('what cannot be invited', () => {
  it('refuses somebody already on the company', async () => {
    const owner = await prisma.user.findFirstOrThrow()
    await expect(createInvitation(ctx, { email: owner.email, name: 'Again', role: 'AUDITOR' }))
      .rejects.toThrow(/already on this company/)
  })

  it('refuses a second open invitation to the same address', async () => {
    await expect(createInvitation(ctx, { email: 'priya@example.com', name: 'Priya Nair', role: 'AUDITOR' }))
      .rejects.toThrow(/already has an invitation open/)
  })

  it('refuses a malformed address', async () => {
    await expect(createInvitation(ctx, { email: 'not-an-email', name: 'X Y', role: 'AUDITOR' }))
      .rejects.toThrow(/not an email address/)
  })

  /** 🔴 An invitation must not be able to set an existing user's password. */
  it('refuses an email that already has an account elsewhere', async () => {
    const other = await prisma.user.create({
      data: { email: 'elsewhere@example.com', name: 'Someone Else', passwordHash: 'x' },
    })
    await expect(createInvitation(ctx, { email: other.email, name: 'Someone Else', role: 'AUDITOR' }))
      .rejects.toThrow(/not something an invitation should be able to do/)
  })
})

/**
 * 🔴 The public half is an oracle if it distinguishes its failures.
 *
 * Unknown, expired, revoked and already-accepted must look identical from outside — otherwise
 * the page tells anybody who asks whether a token ever existed and whether it is still live.
 */
describe('🔴 the public lookup gives nothing away', () => {
  it('returns the same nothing for unknown, revoked and expired', async () => {
    expect(await inviteeFor('not-a-real-token')).toBeNull()
    expect(await inviteeFor('')).toBeNull()

    const { invitation, token } = await createInvitation(ctx, {
      email: 'revoked@example.com', name: 'Revoked Person', role: 'AUDITOR',
    })
    expect(await inviteeFor(token)).not.toBeNull()
    await revokeInvitation(ctx, invitation.id, 'Sent to the wrong address')
    expect(await inviteeFor(token)).toBeNull()

    const { invitation: old, token: oldToken } = await createInvitation(ctx, {
      email: 'expired@example.com', name: 'Expired Person', role: 'AUDITOR',
    })
    await prisma.invitation.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await inviteeFor(oldToken)).toBeNull()
  })

  it('shows only what the page needs, and never the role being choosable', async () => {
    const { token } = await createInvitation(ctx, {
      email: 'visible@example.com', name: 'Visible Person', role: 'PROJECT_MANAGER',
    })
    const v = await inviteeFor(token)
    expect(v).toEqual({
      name: 'Visible Person', email: 'visible@example.com',
      role: 'PROJECT_MANAGER', companyName: expect.any(String),
    })
  })
})

describe('accepting', () => {
  it('creates the user with the role the INVITER chose, and nothing else', async () => {
    const { token } = await createInvitation(ctx, {
      email: 'joiner@example.com', name: 'New Joiner', role: 'ACCOUNTANT',
    })
    const out = await acceptInvitation({ token, password: 'a-long-enough-password' })
    expect(out.email).toBe('joiner@example.com')

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'joiner@example.com' }, include: { companies: true },
    })
    expect(user.isActive).toBe(true)
    expect(user.companies).toHaveLength(1)
    expect(user.companies[0].role).toBe('ACCOUNTANT')
    expect(user.companies[0].companyId).toBe(companyId)
    expect(await verifyPassword(user.passwordHash, 'a-long-enough-password')).toBe(true)

    // 🔴 and nothing that could be used as a session came back
    expect(Object.keys(out)).toEqual(['email'])
  })

  it('is single-use', async () => {
    const { token } = await createInvitation(ctx, {
      email: 'once@example.com', name: 'Once Only', role: 'EMPLOYEE',
    })
    await acceptInvitation({ token, password: 'a-long-enough-password' })
    await expect(acceptInvitation({ token, password: 'another-long-password' }))
      .rejects.toThrow(/not valid/)
    expect(await prisma.user.count({ where: { email: 'once@example.com' } })).toBe(1)
  })

  it('refuses a short password before it touches anything', async () => {
    const { token } = await createInvitation(ctx, {
      email: 'short@example.com', name: 'Short Pass', role: 'EMPLOYEE',
    })
    await expect(acceptInvitation({ token, password: 'short' })).rejects.toThrow(/at least 12/)
    expect(await prisma.user.count({ where: { email: 'short@example.com' } })).toBe(0)
    // and the invitation is still good
    expect(await inviteeFor(token)).not.toBeNull()
  })

  it('🔴 gives one refusal for every reason, so it cannot be probed', async () => {
    const messages: string[] = []
    for (const bad of ['nope', '']) {
      await acceptInvitation({ token: bad, password: 'a-long-enough-password' })
        .catch((e: Error) => messages.push(e.message))
    }
    const { invitation, token } = await createInvitation(ctx, {
      email: 'probe@example.com', name: 'Probe', role: 'AUDITOR',
    })
    await revokeInvitation(ctx, invitation.id, 'Withdrawn before it was used')
    await acceptInvitation({ token, password: 'a-long-enough-password' }).catch((e: Error) => messages.push(e.message))

    expect(messages).toHaveLength(3)
    expect(new Set(messages).size).toBe(1)
  })
})

describe('revoking', () => {
  it('cannot revoke one that has been accepted', async () => {
    const list = await listInvitations(ctx)
    const accepted = list.find((i) => i.email === 'joiner@example.com')!
    await expect(revokeInvitation(ctx, accepted.id, 'Changed our minds'))
      .rejects.toThrow(/already been accepted/)
  })

  it('demands a reason', async () => {
    const { invitation } = await createInvitation(ctx, {
      email: 'reason@example.com', name: 'Reason Needed', role: 'AUDITOR',
    })
    await expect(revokeInvitation(ctx, invitation.id, 'ok')).rejects.toThrow(/not a reason/)
  })
})

describe('who may invite', () => {
  it('refuses anybody without settings.users', async () => {
    for (const role of ['ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR'] as const) {
      await expect(createInvitation({ ...ctx, role }, {
        email: `x-${role}@example.com`, name: 'Nope', role: 'EMPLOYEE',
      })).rejects.toThrow()
    }
  })
})
