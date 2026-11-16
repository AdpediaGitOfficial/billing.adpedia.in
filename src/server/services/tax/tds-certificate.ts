import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { currentFinancialYearOrThrow } from '@/server/services/accounting/period'
import { form16aDue, form16Due } from '@/server/services/compliance/deadlines'
import { isQuarterFiled, formForSectionCode } from './tds-filing'
import type { ReturnForm } from './tds-return'

/**
 * TDS certificates — Form 16A for a vendor, Form 16 for an employee. docs/55.
 *
 * 🔴 This system does not generate either, and must not.
 *
 * Rule 31(1) requires both to be **generated and downloaded from TRACES**. A certificate
 * produced anywhere else carries no digital signature the deductee can verify, and the credit
 * it evidences is the one TRACES holds — not the one our books hold. Printing a convincing
 * imitation would be worse than printing nothing: the deductee would file against a figure
 * the department never saw.
 *
 * So this is a **register and a chase**. It works out who is owed a certificate and by when,
 * records that the real one was downloaded and issued, keeps the downloaded PDF against the
 * record (docs/38), and tells the compliance calendar when there is nothing left to do.
 *
 * 🔴 And a certificate cannot exist before its return is filed — TRACES generates it from the
 * statement. That is why docs/50's filing record had to come first.
 */

export type CertificateForm = '16' | '16A'

export interface CertificateRow {
  /** the register row, where one exists yet */
  id: string | null
  formType: CertificateForm
  quarter: number | null
  deducteeId: string
  deducteeName: string
  isEmployee: boolean
  pan: string | null
  tdsAmount: Decimal
  dueOn: Date
  returnFiled: boolean
  returnForm: ReturnForm
  downloadedOn: Date | null
  issuedOn: Date | null
  issuedTo: string | null
  attachments: number
  /** what stands between this and being done, in order */
  blockedBy: string | null
}

/**
 * Who is owed a certificate, derived from the deductions themselves.
 *
 * 🔴 Derived, never a list somebody maintains. A deductee who was paid once in Q2 and never
 * again is owed a Form 16A for Q2 and nothing else, and no one would remember to add them.
 */
export async function certificateRegister(ctx: RequestContext, fyId?: string): Promise<CertificateRow[]> {
  assertCan(ctx.role, 'tax', 'read')

  const fy = fyId
    ? await prisma.financialYear.findFirstOrThrow({ where: { id: fyId, companyId: ctx.companyId } })
    : await currentFinancialYearOrThrow(ctx.companyId)
  const fyStartYear = Number(fy.label.split('-')[0])

  const [deductions, recorded, attachments] = await Promise.all([
    prisma.tdsDeduction.findMany({
      where: { companyId: ctx.companyId, financialYearId: fy.id, reversedAt: null },
      include: {
        vendor: { select: { id: true, name: true, pan: true } },
        employee: { select: { id: true, name: true, pan: true } },
      },
    }),
    prisma.tdsCertificate.findMany({ where: { companyId: ctx.companyId, financialYearId: fy.id } }),
    prisma.attachment.groupBy({
      by: ['entityId'],
      where: { companyId: ctx.companyId, kind: 'TDS_CERTIFICATE', entityType: 'TdsCertificate', detachedAt: null },
      _count: { _all: true },
    }),
  ])

  const attachmentsBy = new Map(attachments.map((a) => [a.entityId, a._count._all]))

  // 🔴 Form 16 is ANNUAL and Form 16A is QUARTERLY, so they key differently: one row per
  // employee for the year, one row per vendor per quarter.
  type Key = string
  const buckets = new Map<Key, {
    formType: CertificateForm; quarter: number | null
    deducteeId: string; deducteeName: string; isEmployee: boolean; pan: string | null
    tds: Decimal; sections: Set<string>
  }>()

  for (const d of deductions) {
    const isEmployee = d.deducteeType === 'EMPLOYEE'
    const party = isEmployee ? d.employee : d.vendor
    if (!party) continue

    const formType: CertificateForm = isEmployee ? '16' : '16A'
    const quarter = isEmployee ? null : d.quarter
    const key = `${formType}:${quarter ?? 'Y'}:${party.id}`

    const acc = buckets.get(key) ?? {
      formType, quarter,
      deducteeId: party.id, deducteeName: party.name, isEmployee, pan: party.pan,
      tds: ZERO as Decimal, sections: new Set<string>(),
    }
    acc.tds = acc.tds.plus(d.tdsAmount.toString())
    acc.sections.add(d.sectionCode)
    buckets.set(key, acc)
  }

  const rows: CertificateRow[] = []
  for (const b of buckets.values()) {
    const row = recorded.find((r) =>
      r.formType === b.formType && r.quarter === b.quarter &&
      (b.isEmployee ? r.employeeId === b.deducteeId : r.vendorId === b.deducteeId))

    // a 192 deduction is reported on 24Q, everything else by its own section
    const returnForm: ReturnForm = b.isEmployee
      ? '24Q'
      : formForSectionCode([...b.sections][0] ?? '194J')

    // Form 16 needs every quarter's 24Q filed; Form 16A needs its own quarter's
    const quartersNeeded = b.quarter ? [b.quarter] : [1, 2, 3, 4]
    const filedFlags = await Promise.all(
      quartersNeeded.map((q) => isQuarterFiled(ctx.companyId, q, returnForm, fy.id)),
    )
    const returnFiled = filedFlags.every((f) => f.filed)

    const dueOn = b.quarter ? form16aDue(b.quarter as 1 | 2 | 3 | 4, fyStartYear) : form16Due(fyStartYear)
    const attachmentCount = row ? attachmentsBy.get(row.id) ?? 0 : 0

    const blockedBy = !b.pan
      ? 'No PAN — TRACES cannot produce a certificate without one, and the deduction is reported against a blank'
      : !returnFiled
        ? `${returnForm} not recorded as filed — TRACES generates the certificate from the statement`
        : !row?.downloadedOn
          ? 'Not yet downloaded from TRACES'
          : attachmentCount === 0
            ? 'Downloaded, but the file is not on record here'
            : !row?.issuedOn
              ? 'Downloaded and not yet issued'
              : null

    rows.push({
      id: row?.id ?? null,
      formType: b.formType, quarter: b.quarter,
      deducteeId: b.deducteeId, deducteeName: b.deducteeName, isEmployee: b.isEmployee,
      pan: b.pan, tdsAmount: b.tds,
      dueOn, returnFiled, returnForm,
      downloadedOn: row?.downloadedOn ?? null,
      issuedOn: row?.issuedOn ?? null,
      issuedTo: row?.issuedTo ?? null,
      attachments: attachmentCount,
      blockedBy,
    })
  }

  return rows.sort((a, b) =>
    (a.quarter ?? 9) - (b.quarter ?? 9) || a.deducteeName.localeCompare(b.deducteeName))
}

export interface RecordCertificateInput {
  formType: CertificateForm
  quarter?: number | null
  deducteeId: string
  isEmployee: boolean
  tracesRequestNo?: string
  downloadedOn: string
}

/**
 * Record that the certificate was downloaded from TRACES.
 *
 * 🔴 Refused before the return is filed, because TRACES generates it from the statement —
 * recording a download that cannot have happened would turn the chase list green while every
 * deductee is still waiting.
 */
export async function recordCertificateDownload(ctx: RequestContext, input: RecordCertificateInput) {
  assertCan(ctx.role, 'tax', 'write')

  const downloadedOn = new Date(input.downloadedOn)
  if (Number.isNaN(downloadedOn.getTime())) throw new AppError('That is not a valid date')

  const fy = await currentFinancialYearOrThrow(ctx.companyId)
  const register = await certificateRegister(ctx, fy.id)
  const row = register.find((r) =>
    r.formType === input.formType &&
    r.quarter === (input.quarter ?? null) &&
    r.deducteeId === input.deducteeId)
  if (!row) throw new NotFound('Nothing was deducted from that party in this period')

  if (!row.returnFiled) {
    throw new AppError(
      `${row.returnForm} for ${row.quarter ? `Q${row.quarter}` : 'this year'} is not recorded as filed. ` +
      'TRACES generates the certificate from the statement, so there is nothing to download yet — ' +
      'record the filing first.',
    )
  }
  if (!row.pan) {
    throw new AppError(
      `${row.deducteeName} has no PAN on file. TRACES cannot produce a certificate without one, and the ` +
      'deduction has been reported against a blank — collect the PAN and file a C5 correction.',
    )
  }

  // 🔴 findFirst then create/update, not upsert: the unique key has nullable parts (a Form 16
  // has no quarter, and only one of vendor/employee is set), and Prisma's compound-unique
  // input will not take a null. The uniqueness is still enforced by the database.
  const where = {
    companyId: ctx.companyId, financialYearId: fy.id,
    formType: input.formType, quarter: input.quarter ?? null,
    vendorId: input.isEmployee ? null : input.deducteeId,
    employeeId: input.isEmployee ? input.deducteeId : null,
  }
  const existing = await prisma.tdsCertificate.findFirst({ where })

  const saved = existing
    ? await prisma.tdsCertificate.update({
        where: { companyId: ctx.companyId, id: existing.id },
        data: {
          downloadedOn, tracesRequestNo: input.tracesRequestNo?.trim() || null,
          tdsAmount: row.tdsAmount.toFixed(2), pan: row.pan,
        },
      })
    : await prisma.tdsCertificate.create({
        data: {
          ...where,
          pan: row.pan, tdsAmount: row.tdsAmount.toFixed(2),
          downloadedOn, tracesRequestNo: input.tracesRequestNo?.trim() || null,
        },
      })

  await audit(ctx, {
    entity: 'TdsCertificate', entityId: saved.id, action: 'UPDATE',
    after: {
      formType: input.formType, quarter: input.quarter ?? null, deductee: row.deducteeName,
      downloadedOn: downloadedOn.toISOString().slice(0, 10), tracesRequestNo: saved.tracesRequestNo,
    },
  })
  return saved
}

/**
 * Record that it reached the deductee.
 *
 * 🔴 Refused until the downloaded file is actually on record. "Issued" with nothing attached
 * is a claim nobody can check, and the deductee asking for it again a year later is exactly
 * when it matters.
 */
export async function recordCertificateIssued(
  ctx: RequestContext, id: string, issuedOn: string, issuedTo: string,
) {
  assertCan(ctx.role, 'tax', 'write')

  const on = new Date(issuedOn)
  if (Number.isNaN(on.getTime())) throw new AppError('That is not a valid date')
  if (issuedTo.trim().length < 3) throw new AppError('Say where it was sent — an email, a number, a person')

  const cert = await prisma.tdsCertificate.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!cert) throw new NotFound('Certificate record not found')
  if (!cert.downloadedOn) {
    throw new AppError('Record the download from TRACES first — there is nothing to issue yet')
  }

  const attached = await prisma.attachment.count({
    where: {
      companyId: ctx.companyId, kind: 'TDS_CERTIFICATE',
      entityType: 'TdsCertificate', entityId: id, detachedAt: null,
    },
  })
  if (attached === 0) {
    throw new AppError(
      'Attach the certificate downloaded from TRACES first. Recording it as issued with no file is a claim ' +
      'nobody can check — and the deductee asking for it again next year is when that matters.',
    )
  }

  const saved = await prisma.tdsCertificate.update({
    where: { companyId: ctx.companyId, id }, data: { issuedOn: on, issuedTo: issuedTo.trim() },
  })
  await audit(ctx, {
    entity: 'TdsCertificate', entityId: id, action: 'APPROVE',
    after: { issuedOn: on.toISOString().slice(0, 10), issuedTo: issuedTo.trim() },
  })
  return saved
}

/** What the compliance calendar asks: is every certificate for this quarter out? */
export async function certificatesOutstanding(ctx: RequestContext) {
  const rows = await certificateRegister(ctx)
  const byQuarter = new Map<number, { total: number; issued: number }>()
  let form16Total = 0, form16Issued = 0

  for (const r of rows) {
    if (r.formType === '16') {
      form16Total += 1
      if (r.issuedOn) form16Issued += 1
      continue
    }
    const acc = byQuarter.get(r.quarter!) ?? { total: 0, issued: 0 }
    acc.total += 1
    if (r.issuedOn) acc.issued += 1
    byQuarter.set(r.quarter!, acc)
  }

  return { byQuarter, form16: { total: form16Total, issued: form16Issued } }
}
