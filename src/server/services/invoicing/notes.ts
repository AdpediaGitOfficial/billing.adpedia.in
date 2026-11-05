import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import { NO_NOTES, type NoteTotals } from '@/lib/invoice-open'

type Db = Pick<typeof prisma, 'creditNote'>

/**
 * Credit and debit notes standing against a set of invoices — docs/86.
 *
 * 🔴 ONE query for the whole list, not one per invoice. The ageing runs over every open
 * invoice and the month view over a financial year; a lookup per row is what makes a report
 * slow enough that somebody takes it out again.
 *
 * 🔴 `cancelledAt: null`. A cancelled note has been reversed in the ledger and gives the debt
 * back — `credit-note.ts` has always excluded them when deciding how much of an invoice is
 * left to credit, and the same exclusion has to hold here or the two disagree.
 *
 * Credit and debit notes share the `CreditNote` table and differ by `noteType`, so one
 * `groupBy` answers both.
 */
export async function noteTotals(
  companyId: string,
  invoiceIds: string[],
  db: Db = prisma,
): Promise<Map<string, NoteTotals>> {
  const out = new Map<string, NoteTotals>()
  if (invoiceIds.length === 0) return out

  const rows = await db.creditNote.groupBy({
    by: ['invoiceId', 'noteType'],
    where: { companyId, invoiceId: { in: invoiceIds }, cancelledAt: null },
    _sum: { grandTotal: true },
  })

  for (const r of rows) {
    if (!r.invoiceId) continue
    const at = out.get(r.invoiceId) ?? { credited: ZERO, debited: ZERO }
    const amount = new Decimal(r._sum.grandTotal?.toString() ?? '0')
    out.set(r.invoiceId, r.noteType === 'DEBIT'
      ? { ...at, debited: at.debited.plus(amount) }
      : { ...at, credited: at.credited.plus(amount) })
  }
  return out
}

/** The totals for one invoice, for the services that only ever hold one. */
export async function notesFor(
  companyId: string,
  invoiceId: string,
  db: Db = prisma,
): Promise<NoteTotals> {
  return (await noteTotals(companyId, [invoiceId], db)).get(invoiceId) ?? NO_NOTES
}
