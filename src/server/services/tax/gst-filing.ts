import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { buildGstr3b } from './gstr3b'
import { assertFilesGstr1And3b } from './gst-registration'
import { periodsInFy, periodFor } from './periods'
import type { GstReturnType } from '@prisma/client'
import { currentFinancialYear } from '@/server/services/accounting/period'

/**
 * Recording that a GST return was filed.
 *
 * 🔴 The `GstReturnPeriod` model has existed since phase 2 with `filedOn`, `arn` and a
 * `status` of OPEN / PREPARED / FILED — and nothing ever wrote to it. Worse,
 * `accounting/period.ts` carries a comment stating that "a filed GST return advances
 * lockedUpTo automatically", which was simply not true: nothing filed returns and nothing
 * advanced the lock.
 *
 * Three things follow from recording a filing, and the third is the one that matters:
 *
 *   1. the compliance calendar can finally show GSTR-1 and GSTR-3B as done
 *   2. there is a filing history, with ARNs, to reconcile against the portal
 *   3. 🔴 **the period locks** — because the moment a return is filed, changing anything
 *      inside it makes the filed return wrong, silently
 */

/** A GST ARN is 15 characters: 2 state + 2 letters + 10 digits + 1 check. */
const ARN_RE = /^[A-Z]{2}\d{15}$|^[A-Z]{2}\d{10}[A-Z0-9]{3}$|^[A-Z]{2}[A-Z0-9]{13}$/

export interface RecordFilingInput {
  returnType: GstReturnType
  periodLabel: string
  filedOn: string
  arn?: string
}

export interface FilingRow {
  id: string
  returnType: GstReturnType
  periodLabel: string
  filedOn: Date | null
  arn: string | null
  status: string
  outputTax: Decimal
  inputTax: Decimal
  netPayable: Decimal
}

/**
 * File a return.
 *
 * 🔴 The figures are SNAPSHOTTED at the moment of filing, not read live afterwards.
 *
 * What was filed is a historical fact, and it is the thing a notice will be compared
 * against. Reading the books live would mean the "filed" figures quietly tracked every later
 * correction — and the one question that matters at assessment, *"what did we actually
 * report?"*, would become unanswerable.
 */
export async function recordGstFiling(ctx: RequestContext, input: RecordFilingInput) {
  assertCan(ctx.role, 'tax', 'write')

  const filedOn = new Date(input.filedOn)
  if (Number.isNaN(filedOn.getTime())) throw new AppError('That is not a valid filing date')
  if (input.arn && !ARN_RE.test(input.arn.trim().toUpperCase())) {
    throw new AppError(`"${input.arn}" does not look like a GST ARN — 15 characters, as shown on the portal acknowledgement`)
  }

  // 🔴 docs/82 §4 — was `if (!company.gstin)`, which asks the registration question of the
  // wrong field: a composition taxpayer has a GSTIN and files neither of these returns.
  await assertFilesGstr1And3b(ctx.companyId, `a ${input.returnType}`)

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    select: { gstFilingFrequency: true, gstin: true },
  })

  const fy = await currentFinancialYear(ctx.companyId)
  if (!fy) throw new NotFound('No open financial year')

  const period = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
    .find((p) => p.label === input.periodLabel)
  if (!period) throw new AppError(`${input.periodLabel} is not a filing period for FY ${fy.label}`)

  const existing = await prisma.gstReturnPeriod.findFirst({
    where: { companyId: ctx.companyId, periodLabel: period.label, returnType: input.returnType },
  })
  if (existing?.status === 'FILED') {
    throw new AppError(
      `${input.returnType} for ${period.label} is already recorded as filed on ${existing.filedOn?.toISOString().slice(0, 10)}. ` +
      'A return is filed once — a change goes in a later period as an amendment, never by re-filing this one.',
    )
  }

  // the figures as they stand right now, which is what is being filed
  const r = await buildGstr3b(ctx.companyId, period.from, period.to, period.label)
  const summary = {
    // output tax is the GST on taxable outward supplies — zero-rated carries none
    outputTax: r.t31a.igst.plus(r.t31a.cgst).plus(r.t31a.sgst),
    inputTax: r.t4c,
    rcmPaid: r.payable.rcmInCash,
    netPayable: r.payable.total,
  }

  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.gstReturnPeriod.upsert({
      where: {
        companyId_periodLabel_returnType: {
          companyId: ctx.companyId, periodLabel: period.label, returnType: input.returnType,
        },
      },
      update: {
        filedOn, arn: input.arn?.trim().toUpperCase() ?? null, status: 'FILED',
        outputTax: summary.outputTax.toFixed(2),
        inputTax: summary.inputTax.toFixed(2),
        rcmPaid: summary.rcmPaid.toFixed(2),
        netPayable: summary.netPayable.toFixed(2),
      },
      create: {
        companyId: ctx.companyId, financialYearId: fy.id,
        periodLabel: period.label, returnType: input.returnType,
        filedOn, arn: input.arn?.trim().toUpperCase() ?? null, status: 'FILED',
        outputTax: summary.outputTax.toFixed(2),
        inputTax: summary.inputTax.toFixed(2),
        rcmPaid: summary.rcmPaid.toFixed(2),
        netPayable: summary.netPayable.toFixed(2),
      },
    })

    // 🔴 Lock the period. From here, a change to anything dated inside it would make the
    // filed return wrong without anything saying so. Only ever forward — a later filing
    // never un-locks an earlier one.
    const current = await tx.financialYear.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: fy.id } })
    if (!current.lockedUpTo || period.to > current.lockedUpTo) {
      await tx.financialYear.update({ where: { companyId: ctx.companyId, id: fy.id }, data: { lockedUpTo: period.to } })
    }

    return saved
  })

  await audit(ctx, {
    entity: 'GstReturnPeriod', entityId: row.id, action: 'APPROVE',
    after: { returnType: input.returnType, period: period.label, arn: row.arn, netPayable: row.netPayable.toString() },
  })
  return row
}

/** Undo a filing recorded by mistake. The lock stays — unlocking is its own decision. */
export async function unrecordGstFiling(ctx: RequestContext, id: string, reason: string) {
  assertCan(ctx.role, 'tax', 'write')
  if (reason.trim().length < 5) throw new AppError('Say why this filing record is being removed')

  const row = await prisma.gstReturnPeriod.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!row) throw new NotFound('Filing record not found')

  await prisma.gstReturnPeriod.update({
    where: { companyId: ctx.companyId, id }, data: { status: 'PREPARED', filedOn: null, arn: null },
  })
  // 🔴 Deliberately NOT unlocking the period. The return may genuinely have been filed on the
  // portal even if this record was wrong, and quietly reopening a month is how a filed return
  // silently stops matching the books. Unlocking is a separate, explicit act.
  await audit(ctx, { entity: 'GstReturnPeriod', entityId: id, action: 'CANCEL', after: { reason } })
  return { ok: true, note: 'The period stays locked — unlock it separately if that is really intended.' }
}

export async function listGstFilings(ctx: RequestContext): Promise<FilingRow[]> {
  assertCan(ctx.role, 'tax', 'read')
  const rows = await prisma.gstReturnPeriod.findMany({
    where: { companyId: ctx.companyId },
    orderBy: [{ periodLabel: 'desc' }, { returnType: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id, returnType: r.returnType, periodLabel: r.periodLabel,
    filedOn: r.filedOn, arn: r.arn, status: r.status,
    outputTax: new Decimal(r.outputTax.toString()),
    inputTax: new Decimal(r.inputTax.toString()),
    netPayable: new Decimal(r.netPayable.toString()),
  }))
}

/** Which periods are already filed — the calendar asks this to stop nagging. */
export async function filedPeriods(companyId: string): Promise<Set<string>> {
  const rows = await prisma.gstReturnPeriod.findMany({
    where: { companyId, status: 'FILED' },
    select: { periodLabel: true, returnType: true },
  })
  return new Set(rows.map((r) => `${r.returnType}:${r.periodLabel}`))
}

export function currentPeriodLabel(frequency: 'MONTHLY' | 'QUARTERLY', on = new Date()): string {
  return periodFor(on, frequency).label
}

export const ZERO_DECIMAL = ZERO
