import { prisma, type Tx } from '@/server/db'
import { Decimal, ZERO, sumBy, formatINR } from '@/lib/money'
import { UnbalancedJournal, NotFound } from '@/server/errors'
import type { JournalDraft, Posting } from './types'
import type { RequestContext } from '@/server/context'
import { assertPostable } from './period'
import { audit } from '@/server/audit'

export function totals(postings: Posting[]) {
  return {
    debit: sumBy(postings, (p) => p.debit ?? ZERO),
    credit: sumBy(postings, (p) => p.credit ?? ZERO),
  }
}

/**
 * Check 1 of 2. The deferred Postgres constraint trigger is check 2.
 * Two independent assertions, deliberately — see docs/10 §3.1.
 */
export function assertBalanced(postings: Posting[], label = 'journal'): void {
  if (postings.length === 0) throw new UnbalancedJournal(`${label}: no postings`)

  for (const p of postings) {
    const d = p.debit ?? ZERO
    const c = p.credit ?? ZERO
    if (d.isNegative() || c.isNegative()) throw new UnbalancedJournal(`${label}: negative amount on ${p.accountCode}`)
    if (d.isZero() && c.isZero()) throw new UnbalancedJournal(`${label}: zero-value posting on ${p.accountCode}`)
    if (!d.isZero() && !c.isZero()) throw new UnbalancedJournal(`${label}: ${p.accountCode} has both debit and credit`)
  }

  const { debit, credit } = totals(postings)
  if (!debit.equals(credit)) {
    throw new UnbalancedJournal(
      `${label}: debit ${formatINR(debit)} does not equal credit ${formatINR(credit)} (difference ${formatINR(debit.minus(credit))})`,
    )
  }
}

/** Resolve account codes to ids once, so postings can stay code-based and portable. */
async function resolveAccounts(companyId: string, codes: string[], tx: Tx) {
  const unique = [...new Set(codes)]
  const rows = await tx.account.findMany({
    where: { companyId, code: { in: unique } },
    select: { id: true, code: true },
  })
  const map = new Map(rows.map((r) => [r.code, r.id]))
  const missing = unique.filter((c) => !map.has(c))
  if (missing.length) throw new NotFound(`Chart of accounts is missing: ${missing.join(', ')}`)
  return map
}

export async function postJournal(ctx: RequestContext, draft: JournalDraft, tx: Tx = prisma) {
  assertBalanced(draft.postings, draft.narration)

  const fy = await assertPostable(ctx.companyId, draft.date, tx)
  const accounts = await resolveAccounts(ctx.companyId, draft.postings.map((p) => p.accountCode), tx)

  // entryNo is per company per financial year. Reading the max and adding one is racy
  // under concurrent posting — two entries can claim the same number and the unique
  // index then rejects one. Locking the FinancialYear row serialises allocation per
  // year, which is the same mechanism invoice numbering uses.
  await tx.$queryRaw`SELECT id FROM "FinancialYear" WHERE id = ${fy.id} FOR UPDATE`
  const last = await tx.journalEntry.findFirst({
    where: { companyId: ctx.companyId, financialYearId: fy.id },
    orderBy: { entryNo: 'desc' },
    select: { entryNo: true },
  })

  const entry = await tx.journalEntry.create({
    data: {
      companyId: ctx.companyId,
      financialYearId: fy.id,
      entryNo: (last?.entryNo ?? 0) + 1,
      date: draft.date,
      narration: draft.narration,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
      postedById: ctx.userId,
      lines: {
        create: draft.postings.map((p) => ({
          accountId: accounts.get(p.accountCode)!,
          debit: (p.debit ?? ZERO).toFixed(2),
          credit: (p.credit ?? ZERO).toFixed(2),
          narration: p.narration,
          projectId: p.projectId,
          customerId: p.customerId,
          vendorId: p.vendorId,
          employeeId: p.employeeId,
        })),
      },
    },
    include: { lines: true },
  })

  await audit(ctx, { entity: 'JournalEntry', entityId: entry.id, action: 'POST', after: { narration: draft.narration } }, tx)
  return entry
}

/**
 * Never edit a posted entry. Mirror it with debits and credits swapped,
 * dated in an open period.
 */
export async function reverseJournal(ctx: RequestContext, journalEntryId: string, on: Date, reason: string, tx: Tx = prisma) {
  const original = await tx.journalEntry.findFirst({
    where: { id: journalEntryId, companyId: ctx.companyId },
    include: { lines: { include: { account: true } } },
  })
  if (!original) throw new NotFound('Journal entry not found')

  const postings: Posting[] = original.lines.map((l) => ({
    accountCode: l.account.code,
    debit: new Decimal(l.credit.toString()).isZero() ? undefined : new Decimal(l.credit.toString()),
    credit: new Decimal(l.debit.toString()).isZero() ? undefined : new Decimal(l.debit.toString()),
    projectId: l.projectId ?? undefined,
    customerId: l.customerId ?? undefined,
    vendorId: l.vendorId ?? undefined,
    employeeId: l.employeeId ?? undefined,
  }))

  const entry = await postJournal(
    ctx,
    { date: on, narration: `Reversal: ${original.narration} — ${reason}`, sourceType: original.sourceType, sourceId: original.sourceId ?? undefined, postings },
    tx,
  )
  await tx.journalEntry.update({ where: { id: entry.id }, data: { reversalOfId: original.id } })
  return entry
}
