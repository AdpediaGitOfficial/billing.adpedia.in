import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { switchCompany, myCompanies } from '@/server/services/company/switch'
import { chooseCompany } from '@/server/auth/company-choice'
import type { RequestContext } from '@/server/context'

/** docs/82 §3 — moving between entities, and not being moved between them by accident. */

const prisma = new PrismaClient()
let ctxA: RequestContext
let userId = '', companyA = '', companyB = ''

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  userId = user.id
  companyA = a.id
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }

  const b = await createCompany(ctxA, {
    legalName: 'SECOND ENTITY', constitution: 'PROPRIETORSHIP',
    pan: 'AAAPA1234A', stateCode: '32', seriesPrefix: 'SEC',
    address: { line1: 'Thommana', city: 'Thrissur', pincode: '680683' },
  })
  companyB = b.id
})
afterAll(async () => { await prisma.$disconnect() })

describe('switching', () => {
  it('lists every entity this login may open, saying which one it is in', async () => {
    const list = await myCompanies(ctxA)
    expect(list).toHaveLength(2)
    expect(list.map((c) => c.legalName)).toEqual(['ADPEDIA FILMS PRIVATE LIMITED', 'SECOND ENTITY'])
    expect(list.find((c) => c.current)?.companyId).toBe(companyA)
    // the unregistered one reads as unregistered rather than as a blank
    expect(list.find((c) => c.companyId === companyB)?.gstin).toBeNull()
  })

  it('records which books the session is in', async () => {
    const result = await switchCompany(ctxA, companyB)
    expect(result.legalName).toBe('SECOND ENTITY')
    expect(result.role).toBe('OWNER')

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user.lastCompanyId).toBe(companyB)
  })

  /**
   * 🔴 The reason `lastCompanyId` exists at all.
   *
   * A refresh re-signs the access token, and it used to re-read `companies[0]`. After the
   * switch above, a refresh must land back in SECOND ENTITY — not in whichever row the
   * database hands over first. This asserts the property against the real rows.
   */
  it('🔴 a refresh would stay in the entity that was switched to', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { companies: { include: { company: { select: { legalName: true } } } } },
    })
    expect(chooseCompany(user.companies, user.lastCompanyId)?.companyId).toBe(companyB)
  })

  it('writes the move into the audit trail of the books being entered', async () => {
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { companyId: companyB, entity: 'Company', action: 'LOGIN' },
    })
    expect(entry.userId).toBe(userId)
  })

  /**
   * 🔴 The companyId arrives in a form body, so it is a request, not a fact. Without the
   * membership check this switcher would read any company in the installation from a guessed id.
   */
  it('🔴 refuses an entity this login has no membership in', async () => {
    const stranger = await prisma.company.create({
      data: {
        legalName: 'SOMEBODY ELSE LTD', constitution: 'PRIVATE_LIMITED',
        pan: 'AABCS1429B', stateCode: '29', registeredAddress: {},
      },
    })
    await expect(switchCompany(ctxA, stranger.id)).rejects.toThrow(/do not have access/i)

    // and nothing was recorded about it
    expect(await prisma.auditLog.count({ where: { companyId: stranger.id } })).toBe(0)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user.lastCompanyId).not.toBe(stranger.id)
  })

  it('refuses an id that is not a company at all', async () => {
    await expect(switchCompany(ctxA, 'not-a-company')).rejects.toThrow(/do not have access/i)
  })
})
