import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { periodsInFy, periodFor, daysUntil, type GstPeriod } from './periods'
import { gstPosition } from './gst-ledger'
import { buildGstr1 } from './gstr1'
import { buildGstr3b } from './gstr3b'

export async function gstOverview(ctx: RequestContext, periodLabel?: string) {
  assertCan(ctx.role, 'tax', 'read')

  const [company, fy] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
    prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, status: 'OPEN' }, orderBy: { startsOn: 'desc' } }),
  ])
  if (!fy) return null

  const all = periodsInFy(fy.startsOn, fy.endsOn, company.gstFilingFrequency)
  const today = new Date()
  const current = periodFor(today > fy.endsOn ? fy.endsOn : today, company.gstFilingFrequency)
  const selected: GstPeriod = all.find((p) => p.label === periodLabel) ?? all.find((p) => p.label === current.label) ?? all[0]

  const [position, gstr1, gstr3b, filed, lut] = await Promise.all([
    gstPosition(ctx.companyId, selected.from, selected.to),
    buildGstr1(ctx.companyId, selected.from, selected.to, selected.label),
    buildGstr3b(ctx.companyId, selected.from, selected.to, selected.label),
    prisma.gstReturnPeriod.findMany({ where: { companyId: ctx.companyId, periodLabel: selected.label } }),
    prisma.companyLut.findFirst({ where: { companyId: ctx.companyId, fyLabel: fy.label } }),
  ])

  return {
    company, fy,
    frequency: company.gstFilingFrequency,
    periods: all.filter((p) => p.from <= today),
    selected,
    position, gstr1, gstr3b,
    filed: {
      gstr1: filed.find((f) => f.returnType === 'GSTR1') ?? null,
      gstr3b: filed.find((f) => f.returnType === 'GSTR3B') ?? null,
    },
    due: {
      gstr1Days: daysUntil(selected.gstr1DueOn),
      gstr3bDays: daysUntil(selected.gstr3bDueOn),
    },
    lut,
  }
}
