import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import type { Period } from './ledger'

/**
 * A running account with one client, or one vendor — docs/81 §6, build order step 3.
 *
 * 🔴 Read from JOURNAL LINES, like every other report in docs/29. `JournalLine` carries
 * `customerId` and `vendorId`, so a party ledger is one `WHERE` away and is, by construction,
 * the same money the trial balance sees. Rebuilding it from the invoice and receipt tables
 * would produce a statement that could disagree with the balance sheet, and then neither
 * figure would be worth sending to anybody.
 */

/** 1100 Accounts Receivable and 2400 Advances from Customers. */
export const CLIENT_ACCOUNTS = ['1100', '2400'] as const
/** 2000 Accounts Payable. */
export const VENDOR_ACCOUNTS = ['2000'] as const

export type PartyKind = 'CUSTOMER' | 'VENDOR'

export interface PartyLedgerLine {
  id: string
  date: Date
  entryNo: number
  entryId: string
  accountCode: string
  accountName: string
  narration: string
  lineNarration: string | null
  sourceType: string
  sourceId: string | null
  debit: Decimal
  credit: Decimal
  /**
   * Signed in the PARTY's direction: positive increases what a client owes us, or what we
   * owe a vendor. A client's receipt and a vendor's payment are both negative.
   */
  movement: Decimal
  /** running, in the same direction */
  balance: Decimal
  /**
   * The other side of this row's own journal entry — where the money went.
   *
   * 🔴 This is what makes a settlement legible. A receipt credits AR ONCE, for cash plus the
   * TDS withheld (`postReceipt` builds `arCleared` from both), so the ledger shows a single
   * credit of ₹1,18,000 and nothing on the row says ₹10,000 of it was never cash. The
   * sibling lines say it: `₹1,08,000 Axis Bank · ₹10,000 TDS receivable 194J`.
   *
   * It is presentational and is deliberately NOT part of the balance — adding the 1310 debit
   * to the ledger would credit the client twice for the same deduction.
   */
  contra: { code: string; name: string; amount: Decimal; narration: string | null }[]
}

export interface PartyLedger {
  party: { id: string; name: string; kind: PartyKind; subtitle: string | null }
  /** the control accounts this statement spans, named */
  accounts: { code: string; name: string }[]
  opening: Decimal
  debit: Decimal
  credit: Decimal
  closing: Decimal
  lines: PartyLedgerLine[]
  /**
   * 🔴 Documents in this period that are NOT in rupees — and a warning this statement is
   * therefore mixed.
   *
   * `Invoice.fxRate` and `VendorBill.currency` exist and `fxRate` is read nowhere, so a
   * USD 6,500 invoice posts **6,500** into 1100 Accounts Receivable. The ledger is a rupee
   * control account and the figure in it is dollars wearing a rupee sign. This is a defect in
   * the POSTING, older and larger than this statement — it misstates the trial balance, the
   * balance sheet and revenue the same way — and inventing a rate here to paper over it would
   * make a wrong number look deliberate. So the statement says what it contains and lets the
   * reader decide what the total is worth.
   */
  foreignCurrency: { currency: string; count: number }[]
}

const sign = (kind: PartyKind, debit: Decimal, credit: Decimal) =>
  kind === 'CUSTOMER' ? debit.minus(credit) : credit.minus(debit)

async function partyLedger(
  ctx: RequestContext,
  kind: PartyKind,
  partyId: string,
  period: Period,
): Promise<PartyLedger | null> {
  assertCan(ctx.role, 'reports', 'read')

  const codes = kind === 'CUSTOMER' ? [...CLIENT_ACCOUNTS] : [...VENDOR_ACCOUNTS]
  const dimension = kind === 'CUSTOMER' ? { customerId: partyId } : { vendorId: partyId }

  const [party, accounts] = await Promise.all([
    kind === 'CUSTOMER'
      ? prisma.customer.findFirst({ where: { id: partyId, companyId: ctx.companyId }, select: { id: true, name: true, gstin: true } })
      : prisma.vendor.findFirst({ where: { id: partyId, companyId: ctx.companyId }, select: { id: true, name: true, gstin: true, vendorType: true } }),
    prisma.account.findMany({
      where: { companyId: ctx.companyId, code: { in: codes } },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  ])
  if (!party) return null

  const accountIds = accounts.map((a) => a.id)
  const nameByCode = new Map(accounts.map((a) => [a.code, a.name]))

  // the documents behind the period, read only for their currency
  const foreignDocs = kind === 'CUSTOMER'
    ? await prisma.invoice.groupBy({
        by: ['currency'],
        where: {
          // docs/91 — only the ones booked at face value; a foreign invoice with a rate is rupees now
          companyId: ctx.companyId, customerId: partyId, currency: { not: 'INR' }, fxRate: 1,
          status: { not: 'DRAFT' }, date: { gte: period.from, lte: period.to },
        },
        _count: true,
      })
    : await prisma.vendorBill.groupBy({
        by: ['currency'],
        where: {
          // docs/93 — a foreign bill with a rate is rupees in the ledger; only one booked with none is mixed
          companyId: ctx.companyId, vendorId: partyId, currency: { not: 'INR' }, fxRate: 1,
          status: { not: 'DRAFT' }, billDate: { gte: period.from, lte: period.to },
        },
        _count: true,
      })

  const [openingAgg, rows] = await Promise.all([
    prisma.journalLine.aggregate({
      where: {
        ...dimension, accountId: { in: accountIds },
        journalEntry: { companyId: ctx.companyId, date: { lt: period.from } },
      },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.findMany({
      where: {
        ...dimension, accountId: { in: accountIds },
        journalEntry: { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } },
      },
      include: {
        account: { select: { code: true, name: true } },
        journalEntry: { select: { id: true, entryNo: true, date: true, narration: true, sourceType: true, sourceId: true } },
      },
      /**
       * 🔴 docs/81 §6 — `accountLedger`'s ordering, exactly: `[date, entryNo, id]`.
       *
       * `JournalLine` has no ordering column, so the two sides of one entry come back
       * however Postgres feels and a running balance computed line by line differs between
       * two exports of the same statement (docs/58). A new query with its own `orderBy` is
       * a vendor statement that disagrees with itself.
       */
      orderBy: [{ journalEntry: { date: 'asc' } }, { journalEntry: { entryNo: 'asc' } }, { id: 'asc' }],
    }),
  ])

  const opening = sign(
    kind,
    new Decimal(openingAgg._sum.debit?.toString() ?? '0'),
    new Decimal(openingAgg._sum.credit?.toString() ?? '0'),
  )

  // the other side of each entry, in one query rather than one per row
  const entryIds = [...new Set(rows.map((r) => r.journalEntryId))]
  const siblings = entryIds.length === 0 ? [] : await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entryIds }, accountId: { notIn: accountIds } },
    include: { account: { select: { code: true, name: true } } },
    orderBy: [{ id: 'asc' }],
  })
  const contraByEntry = new Map<string, PartyLedgerLine['contra']>()
  for (const s of siblings) {
    const amount = new Decimal(s.debit.toString()).plus(s.credit.toString())
    if (amount.isZero()) continue
    const list = contraByEntry.get(s.journalEntryId) ?? []
    list.push({ code: s.account.code, name: s.account.name, amount, narration: s.narration })
    contraByEntry.set(s.journalEntryId, list)
  }

  let running = opening
  let periodDr = ZERO
  let periodCr = ZERO
  const lines: PartyLedgerLine[] = rows.map((l) => {
    const debit = new Decimal(l.debit.toString())
    const credit = new Decimal(l.credit.toString())
    const movement = sign(kind, debit, credit)
    periodDr = periodDr.plus(debit)
    periodCr = periodCr.plus(credit)
    running = running.plus(movement)
    return {
      id: l.id, date: l.journalEntry.date, entryNo: l.journalEntry.entryNo, entryId: l.journalEntry.id,
      accountCode: l.account.code, accountName: l.account.name,
      narration: l.journalEntry.narration, lineNarration: l.narration,
      sourceType: l.journalEntry.sourceType, sourceId: l.journalEntry.sourceId,
      debit, credit, movement, balance: running,
      contra: contraByEntry.get(l.journalEntryId) ?? [],
    }
  })

  return {
    party: {
      id: party.id, name: party.name, kind,
      subtitle: 'vendorType' in party
        ? [party.gstin, party.vendorType.replace('_', ' ').toLowerCase()].filter(Boolean).join(' · ')
        : party.gstin,
    },
    accounts: codes.map((code) => ({ code, name: nameByCode.get(code) ?? code })),
    opening, debit: periodDr, credit: periodCr, closing: running,
    lines,
    foreignCurrency: foreignDocs.map((d) => ({ currency: d.currency, count: d._count })),
  }
}

export const clientLedger = (ctx: RequestContext, customerId: string, period: Period) =>
  partyLedger(ctx, 'CUSTOMER', customerId, period)

export const vendorLedger = (ctx: RequestContext, vendorId: string, period: Period) =>
  partyLedger(ctx, 'VENDOR', vendorId, period)

/* ── the reconciliation ───────────────────────────────────────────────────── */

export interface PartyReconciliation {
  kind: PartyKind
  accounts: { code: string; name: string }[]
  /** the control-account balance, from the ledger */
  control: Decimal
  /** the same money, added up party by party */
  parties: Decimal
  difference: Decimal
  /**
   * 🔴 Lines on a control account carrying NO party. This is the whole reason the
   * reconciliation exists.
   *
   * docs/80's defect class on the party side: a posting added later that forgets
   * `customerId` drops money out of every client ledger while the trial balance still
   * balances perfectly. Nothing fails, nothing warns, and the first symptom is a client
   * statement that is quietly short. It is zero today (docs/81 §3 measured it), and the only
   * way it stays zero is something that looks.
   */
  unattributed: { count: number; debit: Decimal; credit: Decimal }
  partyCount: number
}

export async function partyReconciliation(
  ctx: RequestContext,
  kind: PartyKind,
  period: Period,
): Promise<PartyReconciliation> {
  assertCan(ctx.role, 'reports', 'read')

  const codes = kind === 'CUSTOMER' ? [...CLIENT_ACCOUNTS] : [...VENDOR_ACCOUNTS]
  const field = kind === 'CUSTOMER' ? 'customerId' : 'vendorId'

  const accounts = await prisma.account.findMany({
    where: { companyId: ctx.companyId, code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })
  const accountIds = accounts.map((a) => a.id)
  const upTo = { companyId: ctx.companyId, date: { lte: period.to } }

  const [controlAgg, attributed, unattributedAgg] = await Promise.all([
    prisma.journalLine.aggregate({
      where: { accountId: { in: accountIds }, journalEntry: upTo },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.groupBy({
      by: [field],
      where: { accountId: { in: accountIds }, journalEntry: upTo, [field]: { not: null } },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.aggregate({
      where: { accountId: { in: accountIds }, journalEntry: upTo, [field]: null },
      _count: true, _sum: { debit: true, credit: true },
    }),
  ])

  const dec = (v: unknown) => new Decimal(v?.toString() ?? '0')
  const control = sign(kind, dec(controlAgg._sum.debit), dec(controlAgg._sum.credit))
  const parties = attributed.reduce(
    (a, r) => a.plus(sign(kind, dec(r._sum.debit), dec(r._sum.credit))),
    ZERO,
  )

  return {
    kind,
    accounts: accounts.map((a) => ({ code: a.code, name: a.name })),
    control, parties, difference: control.minus(parties),
    unattributed: {
      count: unattributedAgg._count,
      debit: dec(unattributedAgg._sum.debit),
      credit: dec(unattributedAgg._sum.credit),
    },
    partyCount: attributed.length,
  }
}

/** Closing balance per party, for a list — one query, not one per row. */
export async function partyBalances(
  ctx: RequestContext,
  kind: PartyKind,
  asOf: Date,
): Promise<Map<string, Decimal>> {
  assertCan(ctx.role, 'reports', 'read')

  const codes = kind === 'CUSTOMER' ? [...CLIENT_ACCOUNTS] : [...VENDOR_ACCOUNTS]
  const field = kind === 'CUSTOMER' ? 'customerId' : 'vendorId'
  const accounts = await prisma.account.findMany({
    where: { companyId: ctx.companyId, code: { in: codes } }, select: { id: true },
  })

  const rows = await prisma.journalLine.groupBy({
    by: [field],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { companyId: ctx.companyId, date: { lte: asOf } },
      [field]: { not: null },
    },
    _sum: { debit: true, credit: true },
  })

  const out = new Map<string, Decimal>()
  for (const r of rows) {
    const id = (r as Record<string, unknown>)[field] as string
    out.set(id, sign(
      kind,
      new Decimal(r._sum.debit?.toString() ?? '0'),
      new Decimal(r._sum.credit?.toString() ?? '0'),
    ))
  }
  return out
}
