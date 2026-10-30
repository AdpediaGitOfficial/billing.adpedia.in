import type { Constitution, Role } from '@prisma/client'
import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { Forbidden } from '@/server/errors'
import { audit } from '@/server/audit'

/**
 * Moving between entities — docs/82 §3.
 *
 * 🔴 No cookie writing happens here, on purpose. This is the part that decides whether the
 * move is allowed and records that it happened; signing the token and setting the cookie is
 * the caller's job. That keeps the decision testable without a request around it, and keeps
 * `next/headers` out of a service.
 */

export interface CompanyOption {
  companyId: string
  legalName: string
  constitution: Constitution
  gstin: string | null
  role: Role
  /** the one this session is in right now */
  current: boolean
}

/** Every entity this user may open, in the same total order the chooser uses. */
export async function myCompanies(ctx: RequestContext): Promise<CompanyOption[]> {
  const memberships = await prisma.userCompany.findMany({
    where: { userId: ctx.userId },
    include: { company: { select: { id: true, legalName: true, constitution: true, gstin: true } } },
    orderBy: [{ company: { legalName: 'asc' } }, { companyId: 'asc' }],
  })

  return memberships.map((m) => ({
    companyId: m.companyId,
    legalName: m.company.legalName,
    constitution: m.company.constitution,
    gstin: m.company.gstin,
    role: m.role,
    current: m.companyId === ctx.companyId,
  }))
}

export interface SwitchResult {
  companyId: string
  legalName: string
  role: Role
}

/**
 * Verify that this user may enter that entity, and record the move.
 *
 * 🔴 The membership is read from the DATABASE, never taken from the request. A companyId in a
 * form body is a request to be checked, not a fact — non-negotiable #6 (docs/10 §3). Without
 * this check the switcher would be a way to read any company in the installation by guessing
 * an id.
 */
export async function switchCompany(ctx: RequestContext, companyId: string): Promise<SwitchResult> {
  const membership = await prisma.userCompany.findUnique({
    where: { userId_companyId: { userId: ctx.userId, companyId } },
    include: { company: { select: { legalName: true } } },
  })
  if (!membership) throw new Forbidden('You do not have access to that company')

  await prisma.user.update({
    where: { id: ctx.userId },
    data: { lastCompanyId: companyId },
  })

  /**
   * 🔴 Audited under the entity being ENTERED, and recorded at all.
   *
   * Somebody opening a second set of books is exactly the event an assessment would ask about,
   * and with two entities under one login it is also how a document ends up in the wrong one.
   * The trail has to be able to say who was in which books, and when.
   */
  await audit({ userId: ctx.userId, companyId }, {
    entity: 'Company', entityId: companyId, action: 'LOGIN',
    after: { enteredFrom: ctx.companyId, role: membership.role },
  })

  return { companyId, legalName: membership.company.legalName, role: membership.role }
}
