import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { postJournal, reverseJournal } from './journal'
import { accountBalances, naturalBalance } from '@/server/services/reports/ledger'
import { trialBalance } from '@/server/services/reports/statements'

/**
 * Locking a period, and closing a year.
 *
 * 🔴 `assertPostable` has always enforced both — it is called by every posting path — but
 * nothing ever SET them. The guard existed with no trigger, so in practice any date in an
 * open year was writable forever, including a month whose GST return had already been filed.
 */

/* ── period lock ─────────────────────────────────────────────────────────────── */

export async function lockPeriod(ctx: RequestContext, fyId: string, upTo: Date) {
  assertCan(ctx.role, 'period.lock', 'approve')

  const fy = await prisma.financialYear.findFirst({ where: { id: fyId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')
  if (fy.status === 'CLOSED') throw new AppError(`FY ${fy.label} is already closed`)

  if (upTo < fy.startsOn || upTo > fy.endsOn) {
    throw new AppError(`${iso(upTo)} is outside FY ${fy.label} (${iso(fy.startsOn)} to ${iso(fy.endsOn)})`)
  }
  // 🔴 Moving the lock BACKWARDS would silently reopen a period whose return has been filed.
  // It is not forbidden — a genuine mistake has to be correctable — but it is a separate,
  // louder operation, so this path refuses it.
  if (fy.lockedUpTo && upTo < fy.lockedUpTo) {
    throw new AppError(
      `The period is already locked to ${iso(fy.lockedUpTo)}. Moving a lock backwards reopens filed months — use "unlock" and say why.`,
    )
  }

  await prisma.financialYear.update({ where: { id: fy.id }, data: { lockedUpTo: upTo } })
  await audit(ctx, { entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    before: { lockedUpTo: fy.lockedUpTo }, after: { lockedUpTo: upTo } })
  return { lockedUpTo: upTo }
}

/** Moving a lock backwards. Separate, and it demands a reason that lands in the audit log. */
export async function unlockPeriod(ctx: RequestContext, fyId: string, upTo: Date | null, reason: string) {
  assertCan(ctx.role, 'period.lock', 'approve')
  if (reason.trim().length < 10) {
    throw new AppError('Reopening a locked period needs a reason — it will be read by whoever audits this')
  }

  const fy = await prisma.financialYear.findFirst({ where: { id: fyId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')
  if (fy.status === 'CLOSED') throw new AppError(`FY ${fy.label} is closed — reopen the year first`)

  await prisma.financialYear.update({ where: { id: fy.id }, data: { lockedUpTo: upTo } })
  await audit(ctx, { entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    before: { lockedUpTo: fy.lockedUpTo }, after: { lockedUpTo: upTo, reason } })
  return { lockedUpTo: upTo }
}

/* ── year-end close ──────────────────────────────────────────────────────────── */

export interface CloseCheck { ok: boolean; label: string; detail: string; blocking: boolean }

export interface ClosePreflight {
  fyLabel: string
  checks: CloseCheck[]
  canClose: boolean
  /** what the closing entry will move into retained earnings */
  netProfit: Decimal
  accountsToSweep: number
}

/**
 * What must be true before a year can be closed.
 *
 * 🔴 Closing is not reversible in any ordinary sense. Reopening is possible, but a closed
 * year that has been reported to a CA, filed against and signed off is not something to
 * reopen casually — so the checks run BEFORE, and the blocking ones genuinely block.
 */
export async function closingPreflight(ctx: RequestContext, fyId: string): Promise<ClosePreflight> {
  assertCan(ctx.role, 'period.lock', 'read')

  const fy = await prisma.financialYear.findFirst({ where: { id: fyId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')

  const period = { from: fy.startsOn, to: fy.endsOn }
  const [tb, balances, draftInvoices, draftBills, openBank, nextFy] = await Promise.all([
    trialBalance(ctx, period),
    accountBalances(ctx, period),
    prisma.invoice.count({ where: { companyId: ctx.companyId, financialYearId: fy.id, status: 'DRAFT' } }),
    prisma.vendorBill.count({ where: { companyId: ctx.companyId, status: 'DRAFT', billDate: { gte: fy.startsOn, lte: fy.endsOn } } }),
    prisma.bankTransaction.count({
      where: { companyId: ctx.companyId, status: { in: ['UNMATCHED', 'SUGGESTED'] }, valueDate: { gte: fy.startsOn, lte: fy.endsOn } },
    }),
    prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, startsOn: { gt: fy.endsOn } }, orderBy: { startsOn: 'asc' } }),
  ])

  const pl = balances.filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE')
  const netProfit = pl.reduce((a, b) => {
    const movement = naturalBalance(b.type, b.debit, b.credit)
    return b.type === 'INCOME' ? a.plus(movement) : a.minus(movement)
  }, ZERO)

  const checks: CloseCheck[] = [
    {
      label: 'Already closed',
      ok: fy.status !== 'CLOSED',
      detail: fy.status === 'CLOSED' ? `FY ${fy.label} is already closed` : 'Open',
      blocking: true,
    },
    {
      label: 'Trial balance balances',
      ok: tb.balanced,
      detail: tb.balanced ? 'Debits equal credits' : `Out by ${tb.difference.toFixed(2)} — the ledger is inconsistent`,
      blocking: true,
    },
    {
      // 🔴 A draft invoice is stranded by closing: its number comes from this year's series,
      // but it could only be posted into the next one.
      label: 'No draft invoices',
      ok: draftInvoices === 0,
      detail: draftInvoices === 0 ? 'None' : `${draftInvoices} draft — send or cancel them, they cannot be issued after closing`,
      blocking: true,
    },
    {
      label: 'No draft bills',
      ok: draftBills === 0,
      detail: draftBills === 0 ? 'None' : `${draftBills} awaiting approval — their input credit is lost if the year closes first`,
      blocking: true,
    },
    {
      label: 'A following year exists',
      ok: !!nextFy,
      detail: nextFy ? `FY ${nextFy.label} is ready` : 'Create the next financial year first — corrections need somewhere to go',
      blocking: true,
    },
    {
      // not blocking: an unreconciled line does not make the books wrong, it makes them
      // unverified. Worth saying loudly; not worth stopping a year-end over.
      label: 'Bank reconciled',
      ok: openBank === 0,
      detail: openBank === 0 ? 'Every line matched' : `${openBank} bank lines still unmatched — the books may not agree with the bank`,
      blocking: false,
    },
  ]

  return {
    fyLabel: fy.label,
    checks,
    canClose: checks.filter((c) => c.blocking).every((c) => c.ok),
    netProfit,
    accountsToSweep: pl.filter((b) => !naturalBalance(b.type, b.debit, b.credit).isZero()).length,
  }
}

/**
 * Close the year.
 *
 * 🔴 The closing entry zeroes every income and expense account and books the difference to
 * **3100 Retained Earnings** — the posting that the balance sheet has been *calculating*
 * until now. Once it exists the profit is a real posted balance, and the derived
 * "prior years not yet closed" line on the balance sheet becomes zero by itself, because
 * there is no longer any P&L movement in that year to derive it from.
 *
 * Nothing posts to 3200 Current Year Profit. It stays a reporting bucket; sweeping into it
 * would leave every closed year's profit stacked in one account that nobody can read.
 */
export async function closeYear(ctx: RequestContext, fyId: string) {
  assertCan(ctx.role, 'period.lock', 'approve')

  const pre = await closingPreflight(ctx, fyId)
  if (!pre.canClose) {
    const failed = pre.checks.filter((c) => c.blocking && !c.ok).map((c) => `${c.label}: ${c.detail}`)
    throw new AppError(`FY ${pre.fyLabel} cannot be closed yet — ${failed.join('; ')}`)
  }

  const fy = await prisma.financialYear.findFirstOrThrow({ where: { id: fyId, companyId: ctx.companyId } })
  const balances = await accountBalances(ctx, { from: fy.startsOn, to: fy.endsOn })

  // reverse each P&L account's own movement, so it lands at exactly zero
  const postings = balances
    .filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE')
    .map((b) => ({ account: b, movement: naturalBalance(b.type, b.debit, b.credit) }))
    .filter((x) => !x.movement.isZero())
    .map((x) => x.account.type === 'INCOME'
      // income is credit-natured: debit it by its balance to clear it
      ? { accountCode: x.account.code, debit: x.movement }
      : { accountCode: x.account.code, credit: x.movement })

  if (postings.length === 0) {
    throw new AppError(`FY ${fy.label} has no income or expense to close`)
  }

  const retained = pre.netProfit
  postings.push(retained.gte(0)
    ? { accountCode: '3100', credit: retained }     // a profit increases retained earnings
    : { accountCode: '3100', debit: retained.abs() })

  const entry = await prisma.$transaction(async (tx) => {
    const e = await postJournal(ctx, {
      // dated the LAST day of the year, so it falls inside the year it closes
      date: fy.endsOn,
      narration: `Year-end closing entry — FY ${fy.label}`,
      sourceType: 'YEAR_END_CLOSE',
      sourceId: fy.id,
      postings,
    }, tx)

    await tx.financialYear.update({
      where: { id: fy.id },
      data: { status: 'CLOSED', lockedUpTo: fy.endsOn },
    })
    return e
  })

  await audit(ctx, { entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    after: { status: 'CLOSED', netProfit: retained.toFixed(2), entryId: entry.id } })

  return { entryId: entry.id, netProfit: retained, accountsSwept: postings.length - 1 }
}

/**
 * Reopen a closed year by REVERSING the closing entry, never by deleting it.
 *
 * 🔴 Deleting it would erase the evidence that the year was ever closed. The reversal
 * leaves both entries in the journal, so an auditor can see exactly what happened and when.
 */
export async function reopenYear(ctx: RequestContext, fyId: string, reason: string) {
  assertCan(ctx.role, 'period.lock', 'approve')
  if (reason.trim().length < 10) {
    throw new AppError('Reopening a closed year needs a reason — it will be read by whoever audits this')
  }

  const fy = await prisma.financialYear.findFirst({ where: { id: fyId, companyId: ctx.companyId } })
  if (!fy) throw new NotFound('Financial year not found')
  if (fy.status !== 'CLOSED') throw new AppError(`FY ${fy.label} is not closed`)

  const closing = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'YEAR_END_CLOSE', sourceId: fy.id, reversalOfId: null },
    orderBy: { postedAt: 'desc' },
  })
  if (!closing) throw new AppError('No closing entry found for that year')

  // unlock first, or postJournal refuses to write the reversal into the year it is reopening
  await prisma.financialYear.update({ where: { id: fy.id }, data: { status: 'OPEN', lockedUpTo: null } })

  const reversal = await reverseJournal(ctx, closing.id, fy.endsOn, reason.trim())

  await audit(ctx, { entity: 'FinancialYear', entityId: fy.id, action: 'UPDATE',
    before: { status: 'CLOSED' }, after: { status: 'OPEN', reason, reversalId: reversal.id } })
  return { reversalId: reversal.id }
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/* ── creating the next year ──────────────────────────────────────────────────── */

/**
 * Open the next financial year.
 *
 * 🔴 The document series is **per financial year**, so creating the year without carrying
 * the series over would break invoice numbering on 1 April: the first invoice of the new
 * year has nothing to draw a number from and simply fails. The series are copied with
 * `nextSeq` reset to 1, because the sequence restarts each year — `ADP/27-28/0001`, not
 * `ADP/27-28/0029`.
 *
 * The pattern itself is carried over unchanged. It contains `{FY}`, which renders from the
 * new year's own label, so nothing in it needs editing.
 */
export async function createNextFinancialYear(ctx: RequestContext) {
  assertCan(ctx.role, 'settings.company', 'write')

  const latest = await prisma.financialYear.findFirst({
    where: { companyId: ctx.companyId },
    orderBy: { startsOn: 'desc' },
  })
  if (!latest) throw new AppError('No financial year exists to follow')

  // 🔴 Take the series from the most recent year that HAS any, not simply from the latest
  // year. A year created without series — by an earlier run of this, or by hand — would
  // otherwise be used as the template and produce another year with no numbering at all,
  // and the failure only shows up on the first invoice of April.
  const template = await prisma.financialYear.findFirst({
    where: { companyId: ctx.companyId, series: { some: {} } },
    orderBy: { startsOn: 'desc' },
    include: { series: true },
  })
  if (!template) {
    throw new AppError('No financial year has document numbering series to copy — set one up before opening the next year')
  }

  // Indian FY: 1 April to 31 March
  const startYear = latest.endsOn.getUTCFullYear()
  const startsOn = new Date(Date.UTC(startYear, 3, 1))
  const endsOn = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59))
  const label = `${startYear}-${String(startYear + 1).slice(2)}`

  const existing = await prisma.financialYear.findFirst({ where: { companyId: ctx.companyId, label } })
  if (existing) throw new AppError(`FY ${label} already exists`)

  const fy = await prisma.$transaction(async (tx) => {
    const created = await tx.financialYear.create({
      data: { companyId: ctx.companyId, label, startsOn, endsOn, status: 'OPEN' },
    })
    for (const s of template.series) {
      await tx.documentSeries.create({
        data: {
          companyId: ctx.companyId, financialYearId: created.id,
          docType: s.docType, prefix: s.prefix, pattern: s.pattern,
          nextSeq: 1,
        },
      })
    }
    return created
  })

  await audit(ctx, { entity: 'FinancialYear', entityId: fy.id, action: 'CREATE',
    after: { label, series: template.series.length } })
  return { id: fy.id, label, seriesCopied: template.series.length }
}
