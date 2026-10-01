import type { Tx } from '@/server/db'
import type { TaxMode } from '@prisma/client'
import { AppError } from '@/server/errors'
import { requiresLut } from '@/server/services/tax/tax-mode'
import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'

export class LutMissing extends AppError {
  constructor(fyLabel: string) {
    super(
      `No valid LUT on file for FY ${fyLabel}. File Form RFD-11 on the GST portal, or raise this invoice with IGST instead.`,
      409,
      'LUT_MISSING',
    )
  }
}

/**
 * 🔴 A hard block, not a warning (docs/03 §7.3).
 *
 * Zero-rating an export without a Letter of Undertaking is not permitted — the supply
 * must then be made WITH payment of IGST and the refund claimed afterwards. LUTs are
 * valid for one financial year and expire silently every 31 March, which is exactly
 * why this is checked at send time rather than trusted to a config field.
 */
export async function resolveLutForInvoice(
  tx: Tx,
  args: { companyId: string; taxMode: TaxMode; fyLabel: string },
): Promise<string | null> {
  if (!requiresLut(args.taxMode)) return null

  const lut = await tx.companyLut.findFirst({
    where: { companyId: args.companyId, fyLabel: args.fyLabel },
  })
  if (!lut) throw new LutMissing(args.fyLabel)
  return lut.id
}

/** Non-throwing variant, so the UI can show the state before the user commits. */
export async function lutStatus(tx: Tx, companyId: string, fyLabel: string) {
  const lut = await tx.companyLut.findFirst({ where: { companyId, fyLabel } })
  return lut
    ? { ok: true as const, arn: lut.arn, fyLabel: lut.fyLabel, filedOn: lut.filedOn }
    : { ok: false as const, fyLabel }
}

/* ── LUT register ─────────────────────────────────────────────────────────── */

/** ARN format: AD + 2-digit state + MMYY + 6 digits + 1 check character. */
export function decodeArn(arn: string): { ok: true; stateCode: string; month: number; year: number; fyLabel: string } | { ok: false; reason: string } {
  const m = /^(A[A-Z])(\d{2})(\d{2})(\d{2})(\d{6})([A-Z0-9])$/.exec(arn.trim().toUpperCase())
  if (!m) return { ok: false, reason: 'Not a recognisable ARN — expected the form AD320325043063O' }
  const [, , stateCode, mm, yy] = m
  const month = Number(mm), year = 2000 + Number(yy)
  if (month < 1 || month > 12) return { ok: false, reason: `Month ${mm} in the ARN is not valid` }
  // Filed in Jan–Mar it covers the FY starting that April; filed later it covers the running FY.
  const fyStart = month <= 3 ? year : year
  return { ok: true, stateCode, month, year, fyLabel: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}` }
}

export async function listLuts(ctx: RequestContext) {
  assertCan(ctx.role, 'settings.company', 'read')
  return prisma.companyLut.findMany({ where: { companyId: ctx.companyId }, orderBy: { fyLabel: 'desc' } })
}

export async function addLut(ctx: RequestContext, input: { arn: string; fyLabel: string; filedOn?: string }) {
  assertCan(ctx.role, 'settings.company', 'write')
  const arn = input.arn.trim().toUpperCase()

  const decoded = decodeArn(arn)
  if (!decoded.ok) throw new AppError(decoded.reason)

  const company = await prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } })
  if (decoded.stateCode !== company.stateCode) {
    throw new AppError(`This ARN was issued in state ${decoded.stateCode}, but the company is registered in ${company.stateCode}.`)
  }
  if (decoded.fyLabel !== input.fyLabel) {
    throw new AppError(
      `The ARN was filed in ${String(decoded.month).padStart(2, '0')}/${decoded.year}, which covers FY ${decoded.fyLabel} — not FY ${input.fyLabel}. A LUT is valid for one financial year only.`,
    )
  }

  const start = Number(input.fyLabel.split('-')[0])
  const lut = await prisma.companyLut.upsert({
    where: { companyId_fyLabel: { companyId: ctx.companyId, fyLabel: input.fyLabel } },
    update: { arn, filedOn: input.filedOn ? new Date(input.filedOn) : undefined },
    create: {
      companyId: ctx.companyId, arn, fyLabel: input.fyLabel,
      filedOn: input.filedOn ? new Date(input.filedOn) : null,
      validFrom: new Date(Date.UTC(start, 3, 1)),
      validTo: new Date(Date.UTC(start + 1, 2, 31, 23, 59, 59)),
    },
  })
  await audit(ctx, { entity: 'CompanyLut', entityId: lut.id, action: 'CREATE', after: { arn, fyLabel: input.fyLabel } })
  return lut
}
