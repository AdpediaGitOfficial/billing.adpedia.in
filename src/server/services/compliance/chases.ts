import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR } from '@/lib/money'
import { formatDocAmount } from '@/lib/fx'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { panRegister } from '@/server/services/tax/pan-register'
import { certificateRegister } from '@/server/services/tax/tds-certificate'
import { compare2b } from '@/server/services/tax/gstr2b'
import { noteTotals } from '@/server/services/invoicing/notes'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'

/**
 * Asking somebody outside this company for something — docs/61.
 *
 * The system already knows every one of these. The PAN register knows which vendor is being
 * over-deducted for want of a number; the certificate register knows who is owed a Form 16A;
 * the ageing report knows who owes money; the 26AS reconciliation knows which client has not
 * reported a deduction. Every one of them ends in a sentence a human has to write, and none
 * of them was ever written.
 *
 * 🔴 This does not send anything, and that is deliberate rather than a shortfall.
 *
 * A payment chase from `noreply@` is ignored; one from the owner's own address gets a reply,
 * because the relationship is with the person, not the software. So the system does the part
 * it is actually better at — knowing who to ask, what to ask for, and what it is costing them
 * — and hands the words to the person whose name is on the email. It is the same posture as
 * the rest of this system: prepare for the CA, never file.
 */

export type ChaseKind =
  | 'PAN_CARD' | 'PAN_NUMBER' | 'FORM_16A' | 'INVOICE_OVERDUE' | 'TDS_CREDIT'
  /** docs/62 — a supplier who has not declared our invoice in their GSTR-1 */
  | 'GSTR1_NOT_FILED'

export interface Chase {
  kind: ChaseKind
  subjectId: string
  partyName: string
  /** best address on file, if any */
  email: string | null
  phone: string | null
  /** why this matters, in one line, for the screen */
  why: string
  subject: string
  body: string
  /** when this party was last asked about this, so nobody asks twice in a week */
  lastAskedAt: Date | null
  /** what it is costing somebody, where there is a figure */
  amount: Decimal | null
}

const DAY = 86_400_000

/**
 * 🔴 A date in a message to a person is written the way a person writes one.
 *
 * The drafts came out saying "fell due on 2026-07-15", which reads like a log line in a
 * letter asking somebody for money. UTC, like every other day-marker in this system — these
 * are dates, not instants, and IST would push a midnight date to the day before.
 */
const day = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

/**
 * 🔴 Every draft is signed by the company and says what it is FOR.
 *
 * A bare "please send your PAN" from an unfamiliar address reads like phishing, which is
 * exactly what a careful recipient should assume. Saying which company, against which
 * payments, and what it costs them to ignore it is what makes it answerable.
 */
function sign(companyName: string, body: string): string {
  return `${body}\n\nThank you,\n${displayName(companyName)}`
}

/**
 * 🔴 The legal name is stored as it is registered — in block capitals. That is right on a
 * letterhead and wrong at the end of an email, where it reads as shouting at somebody you
 * are asking a favour of.
 */
export function displayName(legalName: string): string {
  if (legalName !== legalName.toUpperCase()) return legalName
  return legalName.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export async function outstandingChases(ctx: RequestContext): Promise<Chase[]> {
  assertCan(ctx.role, 'tax', 'read')

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { legalName: true },
  })
  const name = company.legalName

  const out: Chase[] = []
  const asked = await lastAskedMap(ctx.companyId)

  // ── PAN: the one with a price on it ──────────────────────────────────────
  const register = await panRegister(ctx).catch(() => null)
  if (register) {
    const parties = await partyContacts(ctx.companyId, register.rows.map((r) => ({ kind: r.kind, id: r.id })))

    for (const row of register.rows) {
      const contact = parties.get(`${row.kind}:${row.id}`)

      if (!row.pan) {
        const excess = row.excessWithheld
        /**
         * 🔴 An employee is not a vendor, and saying so wrongly is worse than saying nothing.
         *
         * The first draft of this told four salaried people that without a PAN we must
         * deduct 20% "instead of 0% (section 192)" — which is false twice over. Salary TDS
         * is not a rate; it is the year's estimated liability spread over the months
         * (docs/57 §3). And s.206AA on salary is a FLOOR, not a flat rate — docs/47 §1 says
         * exactly this, and the message contradicted it. What an employee without a PAN
         * actually loses is the credit and the Form 16.
         */
        const isEmployee = row.kind === 'EMPLOYEE'
        // and a rate is only quoted where there IS one — "instead of 0%" says nothing
        const rate = row.correctRatePct.gt(0) ? `${row.correctRatePct.toString()}%` : null

        out.push({
          kind: 'PAN_NUMBER', subjectId: row.id, partyName: row.name,
          email: contact?.email ?? null, phone: contact?.phone ?? null,
          why: excess.gt(0)
            ? `${formatINR(excess)} withheld above the normal rate, purely because there is no PAN`
            : isEmployee
              ? 'Tax deducted from salary cannot be credited to them, and Form 16 cannot be issued'
              : 'Deduction will be at 20% under s.206AA until a PAN is on file',
          subject: isEmployee
            ? `We need your PAN for your Form 16 — ${displayName(name)}`
            : `PAN needed for tax deduction — ${displayName(name)}`,
          body: sign(name, isEmployee
            ? `We deduct tax at source from your salary, and we do not have your PAN.\n\n` +
              `Tax is reported against a PAN, so without one the deduction cannot be credited to you: ` +
              `it will not appear in your Form 26AS, and we cannot issue your Form 16 at the end of the ` +
              `year. Section 206AA also sets a minimum of 20% where tax is payable at all.\n\n` +
              `Could you send your PAN, with a photograph of the card if you have one?`
            : `We deduct tax at source on payments to you, and we do not have your PAN.\n\n` +
              `Without it section 206AA requires us to deduct at 20%` +
              `${rate ? `, instead of the ${rate} that applies${row.section ? ` under section ${row.section}` : ''}` : ''}. ` +
              `That money is not lost — but you would only get it back by claiming a refund in your return.\n\n` +
              (excess.gt(0)
                ? `So far this financial year that has come to ${formatINR(excess)} more than it needed to be.\n\n`
                : '') +
              `Could you reply with your PAN? A photograph of the card is ideal, so we can hold it on file.`),
          lastAskedAt: asked.get(`PAN_NUMBER:${row.id}`) ?? null,
          amount: excess.gt(0) ? excess : null,
        })
        continue
      }

      // 🔴 has the number, no copy of the card. Not a rate problem — paperwork, and it is
      // the evidence that we asked, which is what a notice looks for.
      if (row.cards === 0) {
        out.push({
          kind: 'PAN_CARD', subjectId: row.id, partyName: row.name,
          email: contact?.email ?? null, phone: contact?.phone ?? null,
          why: 'PAN on file, no copy of the card behind it',
          subject: `A copy of your PAN card — ${displayName(name)}`,
          body: sign(name,
            `We hold your PAN as ${row.pan} and deduct tax at source against it.\n\n` +
            `Could you send a photograph or scan of the card? We keep it on file as the evidence ` +
            `behind the number, and it saves a question later if the deduction is ever queried.`),
          lastAskedAt: asked.get(`PAN_CARD:${row.id}`) ?? null,
          amount: null,
        })
      }
    }
  }

  // ── Form 16A that has been downloaded and never sent ─────────────────────
  const certificates = await certificateRegister(ctx).catch(() => [])
  for (const c of certificates) {
    if (c.issuedOn || !c.downloadedOn || !c.id) continue
    const contact = await contactFor(ctx.companyId, c.isEmployee ? 'EMPLOYEE' : 'VENDOR', c.deducteeId)
    out.push({
      kind: 'FORM_16A', subjectId: c.id, partyName: c.deducteeName,
      email: contact?.email ?? null, phone: contact?.phone ?? null,
      why: `Form ${c.formType} downloaded from TRACES and not yet sent`,
      subject: `Form ${c.formType}${c.quarter ? ` for Q${c.quarter}` : ''} — ${displayName(name)}`,
      body: sign(name,
        `Attached is your Form ${c.formType}${c.quarter ? ` for quarter ${c.quarter}` : ''}, downloaded from TRACES.\n\n` +
        `It certifies ${formatINR(c.tdsAmount)} of tax deducted and deposited against your PAN. ` +
        `The same figure should appear in your Form 26AS — if it does not, tell us and we will check the return.`),
      lastAskedAt: asked.get(`FORM_16A:${c.id}`) ?? null,
      amount: c.tdsAmount,
    })
  }

  // ── a client's deduction that never reached 26AS ─────────────────────────
  const missing = await prisma.tdsReceivable.findMany({
    where: { companyId: ctx.companyId, status: 'MISSING_IN_26AS' },
    orderBy: { bookedOn: 'desc' },
  })
  const customerIds = [...new Set(missing.map((m) => m.customerId))]
  const customers = customerIds.length
    ? await prisma.customer.findMany({
        where: { companyId: ctx.companyId, id: { in: customerIds } }, select: { id: true, name: true, email: true, phone: true },
      })
    : []
  const custById = new Map(customers.map((c) => [c.id, c]))

  for (const m of missing) {
    const c = custById.get(m.customerId)
    const amount = new Decimal(m.tdsAmount.toString())
    out.push({
      kind: 'TDS_CREDIT', subjectId: m.id, partyName: c?.name ?? 'Unknown client',
      email: c?.email ?? null, phone: c?.phone ?? null,
      why: `${formatINR(amount)} deducted and not showing in our Form 26AS`,
      subject: `TDS credit not appearing in our 26AS — ${displayName(name)}`,
      body: sign(name,
        `You deducted ${formatINR(amount)} of tax at source from a payment to us ` +
        `(section ${m.sectionCode}, quarter ${m.quarter}), and it has not appeared in our Form 26AS.\n\n` +
        `Until it does we cannot claim it in our return, so it is a real cost to us rather than a ` +
        `timing difference. Could you confirm the quarterly statement was filed with our PAN on it, ` +
        `and send the Form 16A?`),
      lastAskedAt: asked.get(`TDS_CREDIT:${m.id}`) ?? null,
      amount,
    })
  }

  /**
   * ── a supplier who has not declared our invoice ──────────────────────────
   *
   * 🔴 The chase with the clearest price on it. docs/62 can name the supplier whose invoice
   * is missing from GSTR-2B, and under s.16(2)(aa) that credit is not available until they
   * file it — the remedy is literally a telephone call, which is what this is for.
   */
  const itc = await compare2b(ctx).catch(() => null)
  if (itc) {
    const vendorNames = itc.notInPortal.filter((x) => x.gstin !== null)
    const bills = vendorNames.length
      ? await prisma.vendorBill.findMany({
          where: { companyId: ctx.companyId, id: { in: vendorNames.map((x) => x.billId) } },
          select: { id: true, vendor: { select: { id: true, email: true, phone: true } } },
        })
      : []
    const byBill = new Map(bills.map((b) => [b.id, b.vendor]))

    for (const row of itc.notInPortal) {
      if (!row.gstin) continue
      const vendor = byBill.get(row.billId)
      out.push({
        kind: 'GSTR1_NOT_FILED', subjectId: row.billId, partyName: row.vendorName,
        email: vendor?.email ?? null, phone: vendor?.phone ?? null,
        why: `${formatINR(row.tax)} of credit we cannot take until they declare invoice ${row.billNumber}`,
        subject: `Invoice ${row.billNumber} is not in our GSTR-2B — ${displayName(name)}`,
        body: sign(name,
          `Your invoice ${row.billNumber} dated ${day(row.billDate)} does not appear in our GSTR-2B.\n\n` +
          `Section 16(2)(aa) means we cannot claim the ${formatINR(row.tax)} of GST on it until it has been ` +
          `declared in your GSTR-1 and reaches our 2B. Could you check it was included, and report it in ` +
          `your next return if it was missed?`),
        lastAskedAt: asked.get(`GSTR1_NOT_FILED:${row.billId}`) ?? null,
        amount: row.tax,
      })
    }
  }

  // ── invoices somebody has not paid ───────────────────────────────────────
  const overdue = await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] },
      dueDate: { lt: new Date() },
    },
    include: { customer: { select: { name: true, email: true, phone: true } } },
    orderBy: { dueDate: 'asc' },
  })
  const invoiceNotes = await noteTotals(ctx.companyId, overdue.map((i) => i.id))

  for (const inv of overdue) {
    /**
     * 🔴 docs/86 — this is the one chase that goes TO A CLIENT, and it asked for the wrong
     * number twice over. It subtracted `amountReceived` from `grandTotal` and nothing else:
     * not the credit notes this company had raised, and not even the TDS the client had
     * already withheld. So the email asked for money that had been given back and for tax the
     * client is legally required to pay to the government instead — the exact letter
     * `receivables.ts` says must never be sent.
     */
    const outstanding = invoiceOpen(inv, invoiceNotes.get(inv.id) ?? NO_NOTES).collectible
    if (outstanding.lte('1')) continue
    const days = Math.floor((Date.now() - inv.dueDate.getTime()) / DAY)
    out.push({
      kind: 'INVOICE_OVERDUE', subjectId: inv.id, partyName: inv.customer.name,
      email: inv.customer.email ?? null, phone: inv.customer.phone ?? null,
      why: `${days} days past the due date`,
      subject: `Invoice ${inv.number} — ${formatDocAmount(inv.currency, outstanding)} outstanding`,
      body: sign(name,
        `Invoice ${inv.number} dated ${day(inv.date)} fell due on ` +
        `${day(inv.dueDate)} and ${formatDocAmount(inv.currency, outstanding)} is still outstanding.\n\n` +
        `Could you let us know when it is scheduled for payment? If it has already been paid, ` +
        `the UTR or cheque details would help us match it.`),
      lastAskedAt: asked.get(`INVOICE_OVERDUE:${inv.id}`) ?? null,
      amount: outstanding,
    })
  }

  return out
}

/** What each subject was last asked, so the screen can say "asked 3 days ago". */
async function lastAskedMap(companyId: string): Promise<Map<string, Date>> {
  const rows = await prisma.chaseLog.findMany({
    where: { companyId }, orderBy: { sentAt: 'desc' },
    select: { kind: true, subjectId: true, sentAt: true },
  })
  const map = new Map<string, Date>()
  for (const r of rows) {
    const key = `${r.kind}:${r.subjectId}`
    if (!map.has(key)) map.set(key, r.sentAt)
  }
  return map
}

interface Contact { email: string | null; phone: string | null }

async function partyContacts(
  companyId: string, parties: { kind: 'EMPLOYEE' | 'VENDOR'; id: string }[],
): Promise<Map<string, Contact>> {
  const vendorIds = parties.filter((p) => p.kind === 'VENDOR').map((p) => p.id)
  const employeeIds = parties.filter((p) => p.kind === 'EMPLOYEE').map((p) => p.id)
  const [vendors, employees] = await Promise.all([
    vendorIds.length ? prisma.vendor.findMany({ where: { id: { in: vendorIds }, companyId }, select: { id: true, email: true, phone: true } }) : [],
    employeeIds.length ? prisma.employee.findMany({ where: { id: { in: employeeIds }, companyId }, select: { id: true, email: true, phone: true } }) : [],
  ])
  const map = new Map<string, Contact>()
  for (const v of vendors) map.set(`VENDOR:${v.id}`, { email: v.email, phone: v.phone })
  for (const e of employees) map.set(`EMPLOYEE:${e.id}`, { email: e.email, phone: e.phone })
  return map
}

async function contactFor(companyId: string, kind: 'EMPLOYEE' | 'VENDOR', id: string): Promise<Contact | null> {
  const m = await partyContacts(companyId, [{ kind, id }])
  return m.get(`${kind}:${id}`) ?? null
}

export interface RecordChaseInput {
  kind: ChaseKind
  subjectId: string
  partyName: string
  sentTo: string
  channel: 'EMAIL' | 'WHATSAPP' | 'PHONE' | 'OTHER'
  message: string
  note?: string
}

/**
 * Record that it was actually sent.
 *
 * 🔴 Explicit, never inferred from the link being clicked. A `mailto:` opens a composer; it
 * does not send anything, and half of them are closed again. A system that marked a chase
 * done because somebody looked at the draft would be worse than one that marked nothing —
 * it would be confidently wrong about whether a vendor had ever been asked.
 */
export async function recordChase(ctx: RequestContext, input: RecordChaseInput) {
  assertCan(ctx.role, 'tax', 'write')
  if (!input.sentTo.trim() || input.sentTo.trim().length < 3) {
    throw new AppError('Say where it was sent — an address, a number, or how it was handed over')
  }
  if (!input.message.trim()) throw new AppError('There is no message to record')

  const row = await prisma.chaseLog.create({
    data: {
      companyId: ctx.companyId, kind: input.kind, subjectId: input.subjectId,
      partyName: input.partyName, sentTo: input.sentTo.trim(), channel: input.channel,
      message: input.message, note: input.note ?? null, sentById: ctx.userId,
    },
  })
  await audit(ctx, {
    entity: 'ChaseLog', entityId: row.id, action: 'CREATE',
    after: { kind: input.kind, subjectId: input.subjectId, channel: input.channel },
  })
  return row
}

export async function chaseHistory(ctx: RequestContext, limit = 40) {
  assertCan(ctx.role, 'tax', 'read')
  return prisma.chaseLog.findMany({
    where: { companyId: ctx.companyId }, orderBy: { sentAt: 'desc' }, take: limit,
  })
}

/** The headline: how much is sitting behind somebody else's inaction. */
export function chaseTotals(rows: Chase[]) {
  const sum = (kinds: ChaseKind[]) =>
    rows.filter((r) => kinds.includes(r.kind)).reduce((a, r) => a.plus(r.amount ?? ZERO), ZERO as Decimal)
  return {
    count: rows.length,
    neverAsked: rows.filter((r) => r.lastAskedAt === null).length,
    overWithheld: sum(['PAN_NUMBER']),
    creditBlocked: sum(['GSTR1_NOT_FILED']),
    unclaimedCredit: sum(['TDS_CREDIT']),
    owedToUs: sum(['INVOICE_OVERDUE']),
  }
}
