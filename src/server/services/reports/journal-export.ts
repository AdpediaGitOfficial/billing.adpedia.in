import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { AppError } from '@/server/errors'
import type { Period } from './ledger'

export interface JournalExportLine {
  entryNo: number
  date: Date
  narration: string
  sourceType: string
  sourceId: string | null
  reversalOf: number | null
  accountCode: string
  accountName: string
  lineNarration: string | null
  debit: Decimal
  credit: Decimal
  project: string | null
  counterparty: string | null
}

export interface JournalExport {
  lines: JournalExportLine[]
  entries: number
  totals: { debit: Decimal; credit: Decimal }
  balanced: boolean
}

/**
 * The whole journal for a period, line by line — docs/58.
 *
 * This is the file an auditor asks for first and the one this system has never been able to
 * hand over. It is deliberately NOT paginated: a journal missing its last page is not a
 * journal, and the drill-through screen's paging exists for reading, not for evidence.
 *
 * 🔴 The order is `date, entryNo, id` and the third is the one that matters. `JournalLine`
 * has no ordering column, so without it the two sides of an entry come back in whatever
 * order the database chooses — and an auditor who exports the same period twice and diffs
 * the files would see them disagree, which is the one thing an evidence file must never do.
 */
export async function journalExport(
  ctx: RequestContext, period: Period, opts: { limit?: number } = {},
): Promise<JournalExport> {
  assertCan(ctx.role, 'journal', 'read')

  const limit = opts.limit ?? 50_000
  const count = await prisma.journalLine.count({
    where: { journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } } },
  })
  // 🔴 refused rather than silently truncated. A journal that stops in the middle of August
  // with no indication is worse than no journal: it balances, and it is wrong.
  if (count > limit) {
    throw new AppError(
      `That period holds ${count.toLocaleString('en-IN')} journal lines, more than this export will produce in one file (${limit.toLocaleString('en-IN')}). ` +
      'Export it a quarter at a time — a journal cut off part way through is worse than none.',
    )
  }

  const rows = await prisma.journalLine.findMany({
    where: { journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } } },
    include: {
      account: { select: { code: true, name: true } },
      project: { select: { code: true, name: true } },
      journalEntry: {
        select: {
          entryNo: true, date: true, narration: true, sourceType: true, sourceId: true,
          reversalOf: { select: { entryNo: true } },
        },
      },
    },
    orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntry: { entryNo: 'asc' } }, { id: 'asc' }],
  })

  // the analytical dimensions are ids on the line; the names are what a reader needs
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter(Boolean) as string[])]
  const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter(Boolean) as string[])]
  const employeeIds = [...new Set(rows.map((r) => r.employeeId).filter(Boolean) as string[])]
  const [customers, vendors, employees] = await Promise.all([
    customerIds.length ? prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }) : [],
    vendorIds.length ? prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } }) : [],
    employeeIds.length ? prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, name: true } }) : [],
  ])
  const nameOf = new Map<string, string>([
    ...customers.map((c) => [c.id, c.name] as [string, string]),
    ...vendors.map((v) => [v.id, v.name] as [string, string]),
    ...employees.map((e) => [e.id, e.name] as [string, string]),
  ])

  let debit = ZERO as Decimal, credit = ZERO as Decimal
  const lines: JournalExportLine[] = rows.map((l) => {
    const d = new Decimal(l.debit.toString()), c = new Decimal(l.credit.toString())
    debit = debit.plus(d); credit = credit.plus(c)
    const party = l.customerId ?? l.vendorId ?? l.employeeId
    return {
      entryNo: l.journalEntry.entryNo,
      date: l.journalEntry.date,
      narration: l.journalEntry.narration,
      sourceType: l.journalEntry.sourceType,
      sourceId: l.journalEntry.sourceId,
      reversalOf: l.journalEntry.reversalOf?.entryNo ?? null,
      accountCode: l.account.code,
      accountName: l.account.name,
      lineNarration: l.narration,
      debit: d, credit: c,
      project: l.project ? `${l.project.code} — ${l.project.name}` : null,
      counterparty: party ? nameOf.get(party) ?? null : null,
    }
  })

  return {
    lines,
    entries: new Set(rows.map((r) => r.journalEntry.entryNo)).size,
    totals: { debit, credit },
    balanced: debit.equals(credit),
  }
}
