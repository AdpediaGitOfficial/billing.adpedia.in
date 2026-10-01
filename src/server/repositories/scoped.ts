import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { Forbidden, NotFound } from '@/server/errors'
import { assertNotReadOnly } from '@/server/auth/permissions'

/**
 * Non-negotiable #6 (docs/10 §3): every query is scoped by the companyId in the JWT,
 * never by one supplied in a request body.
 *
 * This is the single enforcement point. Services take a `Scope`, not a raw Prisma
 * client, so forgetting the companyId filter is not something a caller can do by
 * accident — the filter is applied here, and `where` is merged on top of it.
 */

/** Every company-scoped Prisma delegate. Adding a model to the schema means adding it here. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed by ScopedModel below
const SCOPED_MODELS = [
  'account', 'journalEntry', 'customer', 'project', 'serviceItem', 'invoice', 'creditNote',
  'receipt', 'vendor', 'vendorBill', 'billPayment', 'expenseCategory', 'expense',
  'recurringExpense', 'employee', 'payrollRun', 'tdsDeduction', 'tdsChallan', 'tdsReceivable',
  'gstReturnPeriod', 'companyBankAccount', 'companyLut', 'financialYear', 'documentSeries',
  'bankStatementImport', 'bankTransaction', 'bankRule', 'bankProfile', 'auditLog',
] as const

export type ScopedModel = (typeof SCOPED_MODELS)[number]

type Where = Record<string, unknown>
type Args = { where?: Where } & Record<string, unknown>

export class Scope {
  constructor(readonly ctx: RequestContext) {}

  get companyId() { return this.ctx.companyId }
  get role() { return this.ctx.role }

  /** Merge the company filter into any `where`. Callers cannot widen it. */
  private scopeWhere(where?: Where): Where {
    return { ...(where ?? {}), companyId: this.companyId }
  }

  findMany<M extends ScopedModel>(model: M, args: Args = {}) {
    const d = prisma[model] as unknown as { findMany: (a: Args) => Promise<unknown[]> }
    return d.findMany({ ...args, where: this.scopeWhere(args.where) })
  }

  findFirst<M extends ScopedModel>(model: M, args: Args = {}) {
    const d = prisma[model] as unknown as { findFirst: (a: Args) => Promise<unknown> }
    return d.findFirst({ ...args, where: this.scopeWhere(args.where) })
  }

  count<M extends ScopedModel>(model: M, args: Args = {}) {
    const d = prisma[model] as unknown as { count: (a: Args) => Promise<number> }
    return d.count({ ...args, where: this.scopeWhere(args.where) })
  }

  /**
   * Fetch by id, but only if it belongs to this company.
   * A row from another company is reported as NOT FOUND, never as forbidden —
   * "forbidden" would confirm the id exists.
   */
  async byId<M extends ScopedModel>(model: M, id: string, args: Args = {}) {
    const row = await this.findFirst(model, { ...args, where: { ...(args.where ?? {}), id } })
    if (!row) throw new NotFound(`${model} not found`)
    return row
  }

  /** Every mutating path goes through here. Auditors are stopped by construction. */
  assertCanWrite() {
    assertNotReadOnly(this.role)
  }

  create<M extends ScopedModel>(model: M, data: Record<string, unknown>) {
    this.assertCanWrite()
    const d = prisma[model] as unknown as { create: (a: { data: Record<string, unknown> }) => Promise<unknown> }
    return d.create({ data: { ...data, companyId: this.companyId } })
  }

  async update<M extends ScopedModel>(model: M, id: string, data: Record<string, unknown>) {
    this.assertCanWrite()
    await this.byId(model, id)               // ownership check before any write
    const d = prisma[model] as unknown as { update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> }
    return d.update({ where: { id }, data })
  }

  /**
   * There is deliberately no delete(). Financial records are cancelled and reversed —
   * non-negotiable #4, also enforced by database triggers.
   */
  delete(): never {
    throw new Forbidden('Financial records are never deleted. Cancel the document and post a reversal.')
  }
}

export function scopeFor(ctx: RequestContext) {
  return new Scope(ctx)
}
