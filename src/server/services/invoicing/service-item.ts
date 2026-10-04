import { prisma } from '@/server/db'
import { Decimal, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { validateSac, sacLooksWrongForDescription, lookupSac } from './sac'

/**
 * The service catalogue — docs/67.
 *
 * Seeded since docs/34 and used on every invoice line, with no screen: adding a service meant
 * editing the database. It is the smallest gap left on the list and the one that bites every
 * time the company sells something it has not sold before.
 */

export interface ServiceItemInput {
  name: string
  sacCode?: string | null
  defaultRate?: string
  gstRatePct?: string
  incomeAccountId?: string | null
}

export interface ServiceItemRow {
  id: string
  name: string
  sacCode: string | null
  sacTitle: string | null
  defaultRate: Decimal | null
  gstRatePct: Decimal
  incomeAccountId: string | null
  incomeAccountLabel: string | null
  isActive: boolean
  /** how many invoice lines have used it — why it is deactivated and never deleted */
  usedOn: number
  issues: string[]
}

export async function listServiceItems(ctx: RequestContext): Promise<ServiceItemRow[]> {
  assertCan(ctx.role, 'invoices', 'read')

  const items = await prisma.serviceItem.findMany({
    where: { companyId: ctx.companyId },
    include: { _count: { select: { lines: true } } },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  })
  const accountIds = [...new Set(items.map((i) => i.incomeAccountId).filter(Boolean) as string[])]
  const accounts = accountIds.length
    ? await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true, name: true } })
    : []
  const byId = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]))

  return items.map((i) => {
    const issues = validateSac(i.sacCode).map((s) => s.message)
    const mismatch = sacLooksWrongForDescription(i.name, i.sacCode)
    if (mismatch) issues.push(mismatch.message)
    if (!i.incomeAccountId) {
      issues.push('No income account, so revenue from it falls to the default 4010 — fine if that is what you want.')
    }
    return {
      id: i.id, name: i.name, sacCode: i.sacCode,
      sacTitle: lookupSac(i.sacCode)?.title ?? null,
      defaultRate: i.defaultRate ? new Decimal(i.defaultRate.toString()) : null,
      gstRatePct: new Decimal(i.gstRatePct.toString()),
      incomeAccountId: i.incomeAccountId,
      incomeAccountLabel: i.incomeAccountId ? byId.get(i.incomeAccountId) ?? null : null,
      isActive: i.isActive,
      usedOn: i._count.lines,
      issues,
    }
  })
}

/** The accounts a service item may post revenue to. */
export async function incomeAccounts(ctx: RequestContext) {
  assertCan(ctx.role, 'invoices', 'read')
  return prisma.account.findMany({
    where: { companyId: ctx.companyId, type: 'INCOME', isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })
}

async function validate(ctx: RequestContext, input: ServiceItemInput, excludeId?: string) {
  const name = input.name?.trim()
  if (!name || name.length < 2) throw new AppError('A service needs a name — it is what prints on the invoice line')

  const clash = await prisma.serviceItem.findFirst({
    where: { companyId: ctx.companyId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
  })
  if (clash) throw new AppError(`"${name}" is already in the catalogue`)

  const sac = input.sacCode?.trim() || null
  if (sac) {
    // 🔴 the validator that already exists, called where the code is entered — docs/64's
    // lesson about `validateInvoiceNumber`, which had tests and no caller for fifty-four
    // modules. A SAC is six digits beginning 99, and a wrong one is reported in every GSTR-1.
    const errors = validateSac(sac).filter((i) => i.level === 'error')
    if (errors.length > 0) throw new AppError(errors[0].message)
  }

  const rate = input.gstRatePct !== undefined && input.gstRatePct !== ''
    ? round2(new Decimal(input.gstRatePct))
    : new Decimal(18)
  if (rate.lt(0) || rate.gt(28)) {
    throw new AppError(`${rate.toString()}% is not a GST rate — the slabs are 0, 5, 12, 18 and 28`)
  }

  /**
   * 🔴 The income account must be an INCOME account.
   *
   * It decides where revenue posts when the invoice is sent, and nothing downstream checks
   * it: a service item pointed at a bank account would book every rupee of its revenue into
   * the bank and leave the P&L short, silently, for as long as nobody reconciled.
   */
  let incomeAccountId: string | null = null
  if (input.incomeAccountId) {
    const account = await prisma.account.findFirst({
      where: { id: input.incomeAccountId, companyId: ctx.companyId },
      select: { id: true, type: true, code: true, name: true },
    })
    if (!account) throw new NotFound('That account is not in this chart of accounts')
    if (account.type !== 'INCOME') {
      throw new AppError(
        `${account.code} ${account.name} is ${account.type.toLowerCase()}, not income. Revenue from a service ` +
        'has to post to an income account, or the P&L will be short by everything it sells.',
      )
    }
    incomeAccountId = account.id
  }

  return {
    name,
    sacCode: sac,
    defaultRate: input.defaultRate !== undefined && input.defaultRate !== ''
      ? round2(new Decimal(input.defaultRate)).toFixed(2)
      : null,
    gstRatePct: rate.toFixed(2),
    incomeAccountId,
  }
}

export async function createServiceItem(ctx: RequestContext, input: ServiceItemInput) {
  assertCan(ctx.role, 'invoices', 'write')
  const data = await validate(ctx, input)

  const item = await prisma.serviceItem.create({ data: { companyId: ctx.companyId, ...data } })
  await audit(ctx, { entity: 'ServiceItem', entityId: item.id, action: 'CREATE', after: data })
  return item
}

/**
 * Change one.
 *
 * 🔴 It does not rewrite any invoice. An `InvoiceLine` carries its own description, SAC, rate
 * and GST rate — the service item is a starting point, snapshotted the moment the line is
 * written. The one thing read live is `incomeAccountId`, and only until the invoice is sent;
 * after that the revenue is posted and fixed.
 */
export async function updateServiceItem(ctx: RequestContext, id: string, input: ServiceItemInput) {
  assertCan(ctx.role, 'invoices', 'write')

  const existing = await prisma.serviceItem.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!existing) throw new NotFound('Service not found')

  const data = await validate(ctx, input, id)
  const item = await prisma.serviceItem.update({ where: { id }, data })
  await audit(ctx, {
    entity: 'ServiceItem', entityId: id, action: 'UPDATE',
    before: { name: existing.name, sacCode: existing.sacCode, gstRatePct: existing.gstRatePct.toString() },
    after: data,
  })
  return item
}

/**
 * Retire one — never delete it.
 *
 * 🔴 An invoice line points at it, and a filed invoice's line must keep pointing at something.
 * This is the same rule the rest of the system follows: nothing financial is hard-deleted, and
 * a database trigger refuses it for journal entries. A retired service simply stops being
 * offered on a new invoice.
 */
export async function setServiceItemActive(ctx: RequestContext, id: string, isActive: boolean) {
  assertCan(ctx.role, 'invoices', 'write')
  const existing = await prisma.serviceItem.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!existing) throw new NotFound('Service not found')

  const item = await prisma.serviceItem.update({ where: { id }, data: { isActive } })
  await audit(ctx, {
    entity: 'ServiceItem', entityId: id, action: 'UPDATE',
    before: { isActive: existing.isActive }, after: { isActive },
  })
  return item
}
