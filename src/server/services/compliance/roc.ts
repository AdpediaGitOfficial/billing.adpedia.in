import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { itrPositionFor } from './itr'
import { agmDue } from './deadlines'

/**
 * The registrar's dates — docs/72.
 *
 * Three facts this system cannot derive and has no way to look up: when the AGM was held, and
 * when each of AOC-4 and MGT-7 was filed. The MCA portal is not something this talks to, and
 * `docs/31 §6` already settled the general question — a live portal client is a deliberate
 * non-goal, and the alternative to recording the fact is pretending to know it.
 */
export async function recordRocDates(ctx: RequestContext, input: {
  financialYearId: string
  agmHeldOn?: string | null
  agmSource?: string
  aoc4FiledOn?: string | null
  mgt7FiledOn?: string | null
  /** docs/76 — the two annual tax returns, recorded in the same place for the same reason */
  gstr9FiledOn?: string | null
  gstr9Arn?: string
  itrFiledOn?: string | null
  itrAckNo?: string
}) {
  assertCan(ctx.role, 'settings.company', 'write')

  const fy = await prisma.financialYear.findFirst({
    where: { id: input.financialYearId, companyId: ctx.companyId },
  })
  if (!fy) throw new NotFound('Financial year not found')

  const date = (v: string | null | undefined, what: string) => {
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) throw new AppError(`${what} is not a valid date`)
    /**
     * 🔴 Not before the year it reports on has ended. An AGM cannot adopt accounts that do not
     * exist yet, and a date keyed a year out silently moves both filing deadlines with it —
     * the forms run from the meeting, so a wrong meeting date is two wrong deadlines.
     */
    if (d < fy.endsOn) {
      throw new AppError(
        `${what} cannot be before FY ${fy.label} ended on ${fy.endsOn.toISOString().slice(0, 10)} — ` +
        'the accounts it reports on did not exist yet.',
      )
    }
    return d
  }

  const agmHeldOn = date(input.agmHeldOn, 'The AGM date')
  const aoc4FiledOn = date(input.aoc4FiledOn, 'The AOC-4 filing date')
  const mgt7FiledOn = date(input.mgt7FiledOn, 'The MGT-7 filing date')
  const gstr9FiledOn = date(input.gstr9FiledOn, 'The GSTR-9 filing date')
  const itrFiledOn = date(input.itrFiledOn, 'The ITR filing date')

  /**
   * 🔴 A form cannot be filed before the meeting it reports. s.137(1) and s.92(4) both run
   * FROM the AGM; a filing date earlier than the meeting is a typo, and left alone it would
   * compute a negative delay and clear an obligation that is still open.
   */
  const meeting = agmHeldOn !== undefined ? agmHeldOn : fy.agmHeldOn
  for (const [filed, name] of [[aoc4FiledOn, 'AOC-4'], [mgt7FiledOn, 'MGT-7']] as const) {
    if (filed && meeting && filed < meeting) {
      throw new AppError(`${name} cannot be filed before the AGM on ${meeting.toISOString().slice(0, 10)}`)
    }
    if (filed && !meeting) {
      throw new AppError(`Record the AGM first — ${name} is filed within days of the meeting, and cannot precede it`)
    }
  }

  const updated = await prisma.financialYear.update({
    where: { id: fy.id },
    data: {
      ...(agmHeldOn !== undefined ? { agmHeldOn } : {}),
      ...(input.agmSource !== undefined ? { agmSource: input.agmSource.trim() || null } : {}),
      ...(aoc4FiledOn !== undefined ? { aoc4FiledOn } : {}),
      ...(mgt7FiledOn !== undefined ? { mgt7FiledOn } : {}),
      ...(gstr9FiledOn !== undefined ? { gstr9FiledOn } : {}),
      ...(input.gstr9Arn !== undefined ? { gstr9Arn: input.gstr9Arn.trim().toUpperCase() || null } : {}),
      ...(itrFiledOn !== undefined ? { itrFiledOn } : {}),
      ...(input.itrAckNo !== undefined ? { itrAckNo: input.itrAckNo.trim() || null } : {}),
    },
  })

  await audit(ctx, {
    entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    before: {
      agmHeldOn: fy.agmHeldOn?.toISOString().slice(0, 10) ?? null,
      aoc4FiledOn: fy.aoc4FiledOn?.toISOString().slice(0, 10) ?? null,
      mgt7FiledOn: fy.mgt7FiledOn?.toISOString().slice(0, 10) ?? null,
      gstr9FiledOn: fy.gstr9FiledOn?.toISOString().slice(0, 10) ?? null,
      itrFiledOn: fy.itrFiledOn?.toISOString().slice(0, 10) ?? null,
    },
    after: {
      agmHeldOn: updated.agmHeldOn?.toISOString().slice(0, 10) ?? null,
      aoc4FiledOn: updated.aoc4FiledOn?.toISOString().slice(0, 10) ?? null,
      mgt7FiledOn: updated.mgt7FiledOn?.toISOString().slice(0, 10) ?? null,
      gstr9FiledOn: updated.gstr9FiledOn?.toISOString().slice(0, 10) ?? null,
      itrFiledOn: updated.itrFiledOn?.toISOString().slice(0, 10) ?? null,
    },
  })

  return updated
}

/** The years an annual filing could be outstanding for: every year that has ended. */
export async function rocYears(ctx: RequestContext, now = new Date()) {
  assertCan(ctx.role, 'settings.company', 'read')
  const years = await prisma.financialYear.findMany({
    where: { companyId: ctx.companyId, endsOn: { lt: now } },
    orderBy: { endsOn: 'desc' },
  })
  // 🔴 docs/82 §5d — the ITR date is not a constant, so it is resolved per year rather than
  // printed from `itrDue(…)` at the screen, where it said 31 October to every entity.
  return Promise.all(years.map(async (fy) => ({
    ...fy,
    agmLimit: agmDue(fy.endsOn),
    itr: await itrPositionFor(ctx, fy),
  })))
}
