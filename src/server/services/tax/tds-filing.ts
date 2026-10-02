import { prisma } from '@/server/db'
import { Decimal } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { currentFinancialYearOrThrow } from '@/server/services/accounting/period'
import { buildTdsReturn, type ReturnForm } from './tds-return'

/**
 * Recording that a TDS return was filed — docs/50.
 *
 * 🔴 The GST side got this in docs/44; the TDS side never did. That is not only a reporting
 * gap. A filed 24Q/26Q/27Q reports every deduction in it **against the deductee's PAN**, and
 * it appears in their Form 26AS — which is what makes the payroll run behind it impossible to
 * unsay. Until this record existed, nothing could tell the difference between a mistake and
 * a reported fact, so a cancellation had nothing true to refuse on.
 */

export const TDS_FORMS: ReturnForm[] = ['24Q', '26Q', '27Q']

/**
 * The provisional receipt number from the TIN-FC acknowledgement: 15 digits.
 *
 * Checked loosely on purpose — it is transcribed from a printed acknowledgement, and
 * refusing a filing because the token was mistyped would leave the system believing the
 * quarter is unfiled, which is the more expensive error.
 */
const TOKEN_RE = /^\d{15}$/

export interface RecordTdsFilingInput {
  formType: ReturnForm
  quarter: 1 | 2 | 3 | 4
  filedOn: string
  token?: string
}

export async function recordTdsFiling(ctx: RequestContext, input: RecordTdsFilingInput) {
  assertCan(ctx.role, 'tax', 'write')

  const filedOn = new Date(input.filedOn)
  if (Number.isNaN(filedOn.getTime())) throw new AppError('That is not a valid filing date')

  const token = input.token?.trim()
  if (token && !TOKEN_RE.test(token)) {
    throw new AppError(
      `"${input.token}" does not look like a provisional receipt number — 15 digits, as printed on the TIN-FC acknowledgement`,
    )
  }

  const fy = await currentFinancialYearOrThrow(ctx.companyId)

  const existing = await prisma.tdsReturnFiling.findFirst({
    where: { companyId: ctx.companyId, financialYearId: fy.id, quarter: input.quarter, formType: input.formType },
  })
  if (existing) {
    throw new AppError(
      `${input.formType} for Q${input.quarter} is already recorded as filed on ${existing.filedOn.toISOString().slice(0, 10)}. ` +
      'A correction goes in as a revised return, which is its own filing — not a second record of this one.',
    )
  }

  // 🔴 Snapshotted, like a GST filing (docs/44). What was reported is a historical fact and
  // the thing a TRACES notice is compared against; reading it live afterwards would mean the
  // "filed" figures quietly tracked every later correction.
  const r = await buildTdsReturn(ctx, input.formType, fy.label, input.quarter, filedOn)

  // 🔴 Not refused when the pre-flight still has errors — the CA files from the RPU, and the
  // system is recording what happened, not granting permission for it. But a return filed
  // with deductions and challans disagreeing is worth saying out loud.
  if (!r.totals.tdsDeducted.equals(r.totals.challanTotal)) {
    throw new AppError(
      `${input.formType} Q${input.quarter}: deductions total ${r.totals.tdsDeducted.toFixed(2)} and challans total ` +
      `${r.totals.challanTotal.toFixed(2)}. A return cannot have been accepted with those apart — ` +
      'check the challans are all recorded before marking it filed.',
    )
  }

  const row = await prisma.tdsReturnFiling.create({
    data: {
      companyId: ctx.companyId, financialYearId: fy.id,
      quarter: input.quarter, formType: input.formType, filedOn, token: token ?? null,
      deducteeCount: r.deductees.length,
      tdsDeducted: r.totals.tdsDeducted.toFixed(2),
      tdsDeposited: r.totals.challanTotal.toFixed(2),
      lateFee: r.lateFee ? r.lateFee.fee.toFixed(2) : '0',
    },
  })

  await audit(ctx, {
    entity: 'TdsReturnFiling', entityId: row.id, action: 'APPROVE',
    after: { formType: input.formType, quarter: input.quarter, token: row.token, tds: row.tdsDeducted.toString() },
  })
  return row
}

/**
 * Undo a filing recorded by mistake.
 *
 * 🔴 Only for a record entered in error. It does not unfile anything: if the return really
 * went to the TIN-FC, removing this row makes the system believe deductions can still be
 * cancelled when the deductee's 26AS already shows them.
 */
export async function unrecordTdsFiling(ctx: RequestContext, id: string, reason: string) {
  assertCan(ctx.role, 'tax', 'write')
  if (reason.trim().length < 5) throw new AppError('Say why this filing record is being removed')

  const row = await prisma.tdsReturnFiling.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!row) throw new NotFound('Filing record not found')

  await prisma.tdsReturnFiling.delete({ where: { id } })
  await audit(ctx, {
    entity: 'TdsReturnFiling', entityId: id, action: 'CANCEL',
    before: { formType: row.formType, quarter: row.quarter, filedOn: row.filedOn.toISOString() },
    after: { reason },
  })
  return {
    ok: true,
    note: 'Removed. If the return was actually filed, the deductions in it are already in the deductees’ 26AS — ' +
      'this record is the only thing stopping them being cancelled here.',
  }
}

export interface TdsFilingRow {
  id: string
  formType: string
  quarter: number
  filedOn: Date
  token: string | null
  deducteeCount: number
  tdsDeducted: Decimal
}

export async function listTdsFilings(ctx: RequestContext): Promise<TdsFilingRow[]> {
  assertCan(ctx.role, 'tax', 'read')
  const rows = await prisma.tdsReturnFiling.findMany({
    where: { companyId: ctx.companyId },
    orderBy: [{ quarter: 'asc' }, { formType: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id, formType: r.formType, quarter: r.quarter, filedOn: r.filedOn, token: r.token,
    deducteeCount: r.deducteeCount, tdsDeducted: new Decimal(r.tdsDeducted.toString()),
  }))
}

/**
 * Has this quarter been reported?
 *
 * The guard every cancellation in docs/50 asks. A deduction belongs to one quarter and is
 * reported on the form that matches its section — so a 192 deduction is blocked by a filed
 * 24Q, and a 194J one by a filed 26Q, not by each other.
 */
export async function isQuarterFiled(
  companyId: string, quarter: number, formType: ReturnForm, financialYearId?: string,
): Promise<{ filed: boolean; filedOn?: Date; token?: string | null; tdsDeducted?: Decimal; tdsDeposited?: Decimal }> {
  const row = await prisma.tdsReturnFiling.findFirst({
    where: { companyId, quarter, formType, ...(financialYearId ? { financialYearId } : {}) },
  })
  return row
    ? {
        filed: true, filedOn: row.filedOn, token: row.token,
        tdsDeducted: new Decimal(row.tdsDeducted.toString()),
        tdsDeposited: new Decimal(row.tdsDeposited.toString()),
      }
    : { filed: false }
}

/**
 * 🔴 Would this reversal take the quarter BELOW what was reported?
 *
 * "The quarter is filed, so nothing in it may be touched" is the obvious rule and it is
 * wrong. A payroll run for July that nobody noticed until November did not exist when the Q2
 * return was filed, is in none of its figures, and cancelling it contradicts nothing.
 * Refusing anyway would trap a genuine mistake behind a return it was never part of.
 *
 * What the filing snapshot gives us is the figure that WAS reported. Anything above it
 * arrived afterwards and can go; taking the quarter below it means unsaying something the
 * deductees are already claiming in their 26AS.
 */
export async function wouldContradictFiling(args: {
  companyId: string
  quarter: number
  formType: ReturnForm
  /** the TDS about to be reversed out of the quarter */
  removing: Decimal
  /** 'deducted' for a payroll run, 'deposited' for a challan */
  side: 'deducted' | 'deposited'
}): Promise<{ contradicts: boolean; filedOn?: Date; reported?: Decimal; after?: Decimal }> {
  const filed = await isQuarterFiled(args.companyId, args.quarter, args.formType)
  if (!filed.filed) return { contradicts: false }

  const sections = args.formType === '24Q' ? ['192'] : args.formType === '27Q' ? ['195'] : undefined
  const live = await prisma.tdsDeduction.aggregate({
    where: {
      companyId: args.companyId, quarter: args.quarter, reversedAt: null,
      ...(sections ? { sectionCode: { in: sections } } : { sectionCode: { notIn: ['192', '195'] } }),
      ...(args.side === 'deposited' ? { challanId: { not: null } } : {}),
    },
    _sum: { tdsAmount: true },
  })

  const reported = (args.side === 'deducted' ? filed.tdsDeducted : filed.tdsDeposited) ?? new Decimal(0)
  const after = new Decimal(live._sum.tdsAmount?.toString() ?? '0').minus(args.removing)

  return { contradicts: after.lt(reported), filedOn: filed.filedOn, reported, after }
}

/** Which quarters are filed — the compliance calendar asks. */
export async function filedTdsQuarters(companyId: string): Promise<Set<string>> {
  const rows = await prisma.tdsReturnFiling.findMany({
    where: { companyId }, select: { quarter: true, formType: true },
  })
  return new Set(rows.map((r) => `${r.formType}:${r.quarter}`))
}

/** The form a section is reported on — 24Q salary, 27Q non-resident, 26Q everything else. */
export function formForSectionCode(sectionCode: string): ReturnForm {
  if (sectionCode === '192') return '24Q'
  if (sectionCode === '195') return '27Q'
  return '26Q'
}
