import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal } from '@/server/services/accounting/journal'
import { isForeign, parseFxRate, rateIsSet, toInr } from '@/lib/fx'
import { periodFor } from '@/server/services/tax/periods'
import type { Posting } from '@/server/services/accounting/types'

/**
 * docs/92 — correcting an invoice that was booked at face value.
 *
 * Before docs/91 a USD 250 invoice posted 250 rupees. Those invoices are issued documents with
 * numbers, so they cannot be edited, and cancelling and re-issuing one burns a number in a
 * series that should have none unexplained. What is wrong is only the LEDGER, so that is all
 * this changes: it reads what was actually posted, converts each line at the rate, and posts the
 * DIFFERENCE as a separate entry — the invoice, its number and its document are untouched.
 *
 * 🔴 Read back from the journal, not recomputed from the invoice. Under rule 50 and the GST
 * amendments the heads an invoice posted to are not always the heads it would post to today;
 * what is corrected is what is there.
 */

export interface RebookInput {
  invoiceId: string
  /** rupees per one unit of the invoice currency, on the invoice date */
  fxRate: string
  /** the date of the correcting entry. Defaults to the invoice's own date. */
  date?: string
}

export interface RebookLine {
  accountCode: string
  accountName: string
  /** signed, debit positive — what was posted, then what it should have been */
  was: Decimal
  now: Decimal
  delta: Decimal
}

export interface RebookPreview {
  invoiceId: string
  invoiceNumber: string
  currency: string
  fxRate: Decimal
  entryDate: Date
  lines: RebookLine[]
  /** receivables before and after */
  receivableWas: Decimal
  receivableNow: Decimal
  /** why it cannot be done yet — empty when it can */
  blockers: string[]
  warnings: string[]
}

const signed = (l: { debit: { toString(): string }; credit: { toString(): string } }) =>
  new Decimal(l.debit.toString()).minus(l.credit.toString())

export async function previewRebook(ctx: RequestContext, input: RebookInput): Promise<RebookPreview> {
  assertCan(ctx.role, 'invoices.cancel', 'approve')

  const rate = parseFxRate(input.fxRate)
  if (!rate) throw new AppError('The exchange rate must be a positive number — rupees per one unit of the invoice currency, up to 6 decimals.')
  if (rate.eq(1)) throw new AppError('A rate of 1 is the "not entered" default — enter the real rate.')

  const inv = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, companyId: ctx.companyId },
    include: {
      creditNotes: { where: { cancelledAt: null }, select: { number: true, noteType: true } },
      allocations: { include: { receipt: { select: { number: true, cancelledAt: true } } } },
      customer: { select: { name: true } },
    },
  })
  if (!inv) throw new NotFound('Invoice not found')

  const blockers: string[] = []
  const warnings: string[] = []

  if (inv.status === 'DRAFT') blockers.push(`${inv.number} is a draft — set the rate on the draft itself.`)
  if (inv.status === 'CANCELLED') blockers.push(`${inv.number} is cancelled.`)
  if (!isForeign(inv.currency)) blockers.push(`${inv.number} is in rupees; there is nothing to convert.`)
  else if (rateIsSet(inv.currency, inv.fxRate.toString())) {
    blockers.push(`${inv.number} is already booked at ₹${new Decimal(inv.fxRate.toString()).toFixed(4)} per ${inv.currency}.`)
  }

  /**
   * 🔴 Anything already posted AGAINST the invoice was posted at face value too, and was
   * cleared against a receivable that is about to change by a factor of ~84. Correcting the
   * invoice under it would leave that receivable negative or a stub. Cancel those first — each
   * has its own reversal — then re-book, then record the receipt again with the rupees the bank
   * actually credited, which is the figure the original never captured.
   */
  const receipts = inv.allocations.filter((a) => !a.receipt.cancelledAt).map((a) => a.receipt.number)
  if (receipts.length > 0) {
    blockers.push(`Receipt${receipts.length > 1 ? 's' : ''} ${[...new Set(receipts)].join(', ')} ${receipts.length > 1 ? 'were' : 'was'} recorded against ${inv.number} at face value. Cancel ${receipts.length > 1 ? 'them' : 'it'} first, re-book the invoice, then record the payment again with the rupees the bank credited.`)
  }
  if (inv.creditNotes.length > 0) {
    blockers.push(`${inv.creditNotes.map((n) => n.number).join(', ')} ${inv.creditNotes.length > 1 ? 'were' : 'was'} raised against ${inv.number} at face value. Cancel ${inv.creditNotes.length > 1 ? 'them' : 'it'} first, then re-book.`)
  }
  const amendments = await prisma.gstAmendment.count({ where: { invoiceId: inv.id } })
  if (amendments > 0) blockers.push(`${inv.number} has a GSTR-1 amendment recorded against it at face value, which cannot be un-recorded here — ask the CA.`)

  // what was actually posted, as the invoice itself: the live INVOICE entry, not its reversal
  const entry = await prisma.journalEntry.findFirst({
    where: { companyId: ctx.companyId, sourceType: 'INVOICE', sourceId: inv.id, reversalOfId: null },
    include: { lines: { include: { account: true } } },
  })
  if (!entry) blockers.push(`${inv.number} has no ledger entry to correct.`)

  const entryDate = input.date ? new Date(input.date) : inv.date
  if (Number.isNaN(entryDate.getTime())) throw new AppError('The date of the correcting entry is not a date.')
  if (blockers.length === 0) await assertPostable(ctx.companyId, entryDate)
  if (entryDate.getTime() !== inv.date.getTime()) {
    warnings.push(`The correction is dated ${entryDate.toISOString().slice(0, 10)}, not the invoice's ${inv.date.toISOString().slice(0, 10)}, so the revenue difference lands in that period.`)
  }

  const lines: RebookLine[] = []
  let receivableWas = ZERO, receivableNow = ZERO

  if (entry) {
    // every line but receivables is converted on its own; receivables is what balances them,
    // which is how postInvoice builds the entry in the first place
    const converted = entry.lines.map((l) => {
      const was = signed(l)
      return { l, was, now: l.account.code === '1100' ? ZERO : toInr(was, rate) }
    })
    const others = converted.filter((c) => c.l.account.code !== '1100').reduce((a, c) => a.plus(c.now), ZERO)
    for (const c of converted) {
      if (c.l.account.code === '1100') c.now = others.neg()
    }
    // fold lines on the same account and dimensions into one, so a correction is one line per head
    const byKey = new Map<string, RebookLine & { dim: Pick<Posting, 'customerId' | 'projectId' | 'vendorId' | 'employeeId'> }>()
    for (const c of converted) {
      const dim = { customerId: c.l.customerId ?? undefined, projectId: c.l.projectId ?? undefined, vendorId: c.l.vendorId ?? undefined, employeeId: c.l.employeeId ?? undefined }
      const key = [c.l.account.code, dim.customerId, dim.projectId, dim.vendorId, dim.employeeId].join('|')
      const acc = byKey.get(key) ?? { accountCode: c.l.account.code, accountName: c.l.account.name, was: ZERO, now: ZERO, delta: ZERO, dim }
      acc.was = acc.was.plus(c.was); acc.now = acc.now.plus(c.now); acc.delta = acc.now.minus(acc.was)
      byKey.set(key, acc)
    }
    for (const v of byKey.values()) {
      lines.push(v)
      if (v.accountCode === '1100') { receivableWas = receivableWas.plus(v.was); receivableNow = receivableNow.plus(v.now) }
    }
  }

  // The return for this invoice's period may already have gone in at face value. The books
  // are right after this; the return is the CA's to amend, and saying so is not optional.
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstFilingFrequency: true, gstRegistrationType: true },
  })
  if (inv.taxMode === 'EXPORT' && carriesReturn(company.gstRegistrationType)) {
    const label = periodFor(inv.date, company.gstFilingFrequency).label
    const filed = await prisma.gstReturnPeriod.findFirst({
      where: { companyId: ctx.companyId, periodLabel: label, returnType: 'GSTR1', status: 'FILED' },
    })
    if (filed) {
      warnings.push(`GSTR-1 for ${label} was filed with this export at its dollar figure. The books will be right after this; the return has to be amended — ask the CA.`)
    }
  }

  return {
    invoiceId: inv.id, invoiceNumber: inv.number, currency: inv.currency, fxRate: rate, entryDate,
    lines, receivableWas, receivableNow, blockers, warnings,
  }
}

/**
 * 🔴 Refuse to post anything AGAINST an issued foreign invoice that is still at face value.
 *
 * A receipt or note converts at the invoice's rate, and for one with no rate that is 1: the
 * entry would balance and be wrong in exactly the way this module exists to correct, and would
 * then block the correction (it refuses when anything has been posted against the invoice).
 */
export function assertBookedAtRate(inv: { number: string; currency: string; fxRate: { toString(): string } }) {
  if (isForeign(inv.currency) && !rateIsSet(inv.currency, inv.fxRate.toString())) {
    throw new AppError(
      `${inv.number} is in ${inv.currency} and is still booked at face value, with no exchange rate. ` +
      'Book it at its rate first (Invoices → the invoice → Book at a rate), then record this.',
    )
  }
}

const carriesReturn = (r: string) => r !== 'UNREGISTERED'

/**
 * Set the rate on an issued foreign invoice that has none, and post the difference.
 * One transaction: the rate and the entry stand or fall together.
 */
export async function rebookInvoiceAtRate(ctx: RequestContext, input: RebookInput) {
  const p = await previewRebook(ctx, input)
  if (p.blockers.length > 0) throw new AppError(p.blockers.join(' '))

  const postings: Posting[] = []
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { companyId: ctx.companyId, sourceType: 'INVOICE', sourceId: p.invoiceId, reversalOfId: null },
    include: { lines: { include: { account: true } } },
  })
  // rebuild the dimensions per account the way the preview folded them
  const dimOf = new Map<string, Pick<Posting, 'customerId' | 'projectId' | 'vendorId' | 'employeeId'>>()
  for (const l of entry.lines) {
    dimOf.set(l.account.code, {
      customerId: l.customerId ?? undefined, projectId: l.projectId ?? undefined,
      vendorId: l.vendorId ?? undefined, employeeId: l.employeeId ?? undefined,
    })
  }
  for (const l of p.lines) {
    if (l.delta.isZero()) continue
    const dim = dimOf.get(l.accountCode) ?? {}
    postings.push(l.delta.gt(0)
      ? { accountCode: l.accountCode, debit: l.delta, ...dim }
      : { accountCode: l.accountCode, credit: l.delta.abs(), ...dim })
  }
  if (postings.length === 0) throw new AppError('Nothing would change at that rate.')

  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: p.invoiceId, companyId: ctx.companyId } })
    // re-checked inside the transaction: a receipt recorded a moment ago must stop this
    if (rateIsSet(inv.currency, inv.fxRate.toString())) throw new AppError(`${inv.number} was just booked at a rate by someone else.`)
    if (new Decimal(inv.amountReceived.toString()).gt(0)) throw new AppError(`${inv.number} has just had a receipt recorded against it. Cancel it and try again.`)

    const posted = await postJournal(ctx, {
      date: p.entryDate,
      narration: `Re-booked ${inv.number} at ₹${p.fxRate.toFixed(4)} per ${inv.currency} — it was booked at face value`,
      sourceType: 'FX_REBOOK', sourceId: inv.id,
      postings,
    }, tx)

    await tx.invoice.update({ where: { id: inv.id }, data: { fxRate: p.fxRate.toFixed(6) } })
    await audit(ctx, {
      entity: 'Invoice', entityId: inv.id, action: 'UPDATE',
      before: { fxRate: inv.fxRate.toString() },
      after: { fxRate: p.fxRate.toFixed(6), rebooked: true, receivable: `${p.receivableWas.toFixed(2)} -> ${p.receivableNow.toFixed(2)}` },
    }, tx)
    return { entryId: posted.id, preview: p }
  })
}

/** Issued foreign invoices still booked at face value — the ones this tool is for. */
export async function invoicesNeedingRebook(ctx: RequestContext) {
  assertCan(ctx.role, 'invoices', 'read')
  const rows = await prisma.invoice.findMany({
    where: { companyId: ctx.companyId, currency: { not: 'INR' }, fxRate: 1, status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: { id: true, number: true, date: true, currency: true, grandTotal: true, status: true, customer: { select: { name: true } } },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  return rows
}
