import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { postExpense } from '@/server/services/accounting/rules/purchase'

/**
 * s.17(5) blocked credits. The expense form sets eligibility from the category and
 * requires a typed reason to override — nobody should be deciding this per receipt
 * from memory (docs/04 §3).
 */
export const BLOCKED_REASONS = {
  S17_5_B_FOOD: 'Food, beverages, restaurant or outdoor catering — s.17(5)(b)',
  S17_5_B_CAB: 'Passenger transport — cab or taxi — s.17(5)(b)',
  NO_REGISTRATION_IN_STATE: 'Hotel GST charged in a state where Adpedia has no registration',
  S17_5_G_PERSONAL: 'Personal consumption — s.17(5)(g)',
  UNREGISTERED_SUPPLIER: 'Supplier is unregistered — no tax invoice, nothing to claim',
  NO_GSTIN_ON_INVOICE: 'Invoice does not carry Adpedia’s GSTIN — the credit is lost, not deferred',
} as const
export type BlockedReason = keyof typeof BLOCKED_REASONS

export interface ExpenseInput {
  categoryId: string
  date: string
  description: string
  taxableValue: string
  gstRatePct?: string
  /** INTRA splits CGST+SGST, INTER is IGST, NONE for an unregistered or foreign supplier */
  gstMode?: 'INTRA' | 'INTER' | 'NONE'
  projectId?: string
  vendorId?: string
  employeeId?: string
  paidFrom?: 'BANK' | 'CASH' | 'CARD' | 'PERSONAL_REIMBURSABLE'
  bankAccountId?: string
  itcEligible?: boolean
  itcBlockedReason?: BlockedReason
  receiptUrl?: string
  /** 🔴 set by the offline queue — makes a replayed submission a no-op (docs/30 §2) */
  clientKey?: string
}

export async function createExpense(ctx: RequestContext, input: ExpenseInput) {
  assertCan(ctx.role, 'expenses.own', 'write')

  // 🔴 Replay guard. The offline queue retries anything it did not see a response for,
  // and "no response" includes the case where the server committed and the network died
  // on the way back. Without this, filing one expense on a train books it twice — and
  // claims its input credit twice on the GST return, which is the part that is hard to
  // unpick three months later. Checked before any work so a replay is cheap.
  if (input.clientKey) {
    const existing = await prisma.expense.findUnique({
      where: { companyId_clientKey: { companyId: ctx.companyId, clientKey: input.clientKey } },
    })
    if (existing) return existing
  }

  const date = new Date(input.date)
  const fy = await assertPostable(ctx.companyId, date)

  const category = await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, companyId: ctx.companyId } })
  if (!category) throw new NotFound('Expense category not found')
  // ExpenseCategory carries accountId as a plain column, not a relation
  const account = await prisma.account.findUniqueOrThrow({ where: { id: category.accountId } })

  const taxable = round2(new Decimal(input.taxableValue))
  if (taxable.lte(0)) throw new AppError('An expense needs a positive amount')

  const mode = input.gstMode ?? (category.gstTreatment === 'NONE' ? 'NONE' : 'INTRA')
  const ratePct = new Decimal(input.gstRatePct ?? (category.gstTreatment === 'STANDARD_12' ? '12' : category.gstTreatment === 'STANDARD_5' ? '5' : '18'))

  let cgst = ZERO, sgst = ZERO, igst = ZERO
  if (mode !== 'NONE' && category.gstTreatment !== 'EXEMPT') {
    const tax = round2(taxable.mul(ratePct).div(100))
    if (mode === 'INTER') igst = tax
    else { cgst = round2(tax.div(2)); sgst = round2(tax.minus(cgst)) }
  }
  const total = taxable.plus(cgst).plus(sgst).plus(igst)

  // default eligibility from the category; an override must name a reason
  const defaultEligible = category.itcDefault === 'FULL'
  const itcEligible = input.itcEligible ?? defaultEligible
  if (!itcEligible && !input.itcBlockedReason && (cgst.gt(0) || sgst.gt(0) || igst.gt(0))) {
    throw new AppError('Blocking input credit needs a reason — pick the clause that applies')
  }
  if (itcEligible && category.itcDefault === 'BLOCKED') {
    throw new AppError(`Input credit is blocked for ${category.name} by default. Claiming it needs a deliberate override and a reason.`)
  }

  const bank = input.bankAccountId
    ? await prisma.companyBankAccount.findFirstOrThrow({ where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true } })
    : await prisma.companyBankAccount.findFirst({ where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true } })

  const expense = await prisma.expense.create({
    data: {
      companyId: ctx.companyId, financialYearId: fy.id,
      categoryId: category.id, projectId: input.projectId, vendorId: input.vendorId, employeeId: input.employeeId,
      date, description: input.description,
      taxableValue: taxable.toFixed(2),
      cgst: cgst.toFixed(2), sgst: sgst.toFixed(2), igst: igst.toFixed(2),
      total: total.toFixed(2),
      itcEligible,
      itcBlockedReason: input.itcBlockedReason ? BLOCKED_REASONS[input.itcBlockedReason] : null,
      paidFrom: input.paidFrom ?? 'BANK',
      receiptUrl: input.receiptUrl,
      clientKey: input.clientKey,
      status: 'APPROVED',
    },
  })

  await postJournal(ctx, {
    date, narration: input.description,
    sourceType: 'EXPENSE', sourceId: expense.id,
    postings: postExpense({
      description: input.description,
      accountCode: account.code,
      projectId: input.projectId, vendorId: input.vendorId, employeeId: input.employeeId,
      taxableValue: taxable, cgst, sgst, igst, total,
      itcEligible,
      paidFrom: input.paidFrom ?? 'BANK',
      bankAccountCode: bank?.ledgerAccount?.code ?? '1010',
    }),
  })

  await audit(ctx, { entity: 'Expense', entityId: expense.id, action: 'CREATE', after: { total: total.toFixed(2), itcEligible } })
  return expense
}

export async function listExpenses(ctx: RequestContext, limit = 100) {
  assertCan(ctx.role, 'expenses.own', 'read')
  return prisma.expense.findMany({
    // 🔴 Cancelled ones are LISTED, struck through — docs/49.
    //
    // They used to be filtered out, on the reasoning that showing them would double them up
    // against their reversal. But nothing financial is deleted in this system, and an
    // expense that simply vanishes when it is cancelled is indistinguishable from one that
    // was. The receipts list already settled this the other way: show it, strike it, and
    // keep it out of the totals.
    where: { companyId: ctx.companyId },
    include: { category: true, project: { select: { name: true } } },
    orderBy: { date: 'desc' },
    take: limit,
  })
}

/**
 * Which expenses have no receipt on file — docs/59.
 *
 * 🔴 The ones that matter are the ones claiming input credit. Rule 36(1) makes the credit
 * claimable against a tax invoice the recipient **holds**; s.16(2)(a) says the same from the
 * other side. An expense with ₹9,000 of ITC and no document behind it is a claim that cannot
 * be sustained when it is asked about, and nothing in this system has ever said which those
 * were — the evidence and the claim lived in different places.
 */
export async function expensesWithoutEvidence(ctx: RequestContext) {
  assertCan(ctx.role, 'expenses.own', 'read')

  const expenses = await prisma.expense.findMany({
    where: { companyId: ctx.companyId, cancelledAt: null },
    include: { category: true },
    orderBy: { date: 'desc' },
  })
  if (expenses.length === 0) return { rows: [], itcAtRisk: ZERO as Decimal }

  const attached = await prisma.attachment.findMany({
    where: {
      companyId: ctx.companyId, entityType: 'Expense', detachedAt: null,
      entityId: { in: expenses.map((e) => e.id) },
    },
    select: { entityId: true },
  })
  const have = new Set(attached.map((a) => a.entityId))

  const rows = expenses
    .filter((e) => !have.has(e.id))
    .map((e) => ({
      id: e.id,
      date: e.date,
      description: e.description,
      category: e.category.name,
      total: new Decimal(e.total.toString()),
      itc: e.itcEligible
        ? new Decimal(e.cgst.toString()).plus(e.sgst.toString()).plus(e.igst.toString())
        : ZERO,
    }))

  return {
    rows,
    itcAtRisk: rows.reduce((a, r) => a.plus(r.itc), ZERO as Decimal),
  }
}
