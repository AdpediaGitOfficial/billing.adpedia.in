import { prisma } from '@/server/db'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import { pushToCompany, messages, type PushMessage } from './push'
import { noteTotals } from '@/server/services/invoicing/notes'
import { invoiceOpen, NO_NOTES } from '@/lib/invoice-open'
import type { RequestContext } from '@/server/context'

/**
 * Deciding what to say, and when — docs/60.
 *
 * Every message this system can send has existed since docs/30: the sender, the four
 * payloads, the subscriptions. Only one of them has ever fired — payment-received, off a
 * real receipt. The compliance calendar is read and never delivered; the ageing report knows
 * exactly which invoices are overdue and tells nobody; the PAN register lists who has not
 * sent their card and asks them nothing.
 *
 * 🔴 Nothing is queued. Every message is computed at the moment of sending, from live data,
 * because a reminder prepared last night about an invoice paid this morning is worse than no
 * reminder at all — it is the one that destroys trust in all the others.
 */

const DAY = 86_400_000

/** 🔴 The day at UTC midnight, which is what makes "already sent today" a decidable question. */
export function dayKey(on: Date): Date {
  return new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate()))
}

export interface Planned {
  kind: string
  subjectId: string
  message: PushMessage
  /** roles that can act on it — nobody else needs waking up */
  roles?: string[]
}

/**
 * 🔴 An overdue invoice is chased on a SCHEDULE, not every morning.
 *
 * Daily is how a person turns notifications off, and then never hears the one that mattered.
 * The first day it is late, then at a week, a fortnight, a month, and monthly after that —
 * which is roughly how a human would chase, and the cadence is deliberate rather than
 * whatever the cron happens to do.
 */
export function shouldChaseOverdue(daysOverdue: number): boolean {
  if (daysOverdue < 1) return false
  if (daysOverdue === 1 || daysOverdue === 7 || daysOverdue === 14) return true
  return daysOverdue % 30 === 0
}

/**
 * What ought to go out today.
 *
 * Read-only and safe to call from a screen: this is also what the preview shows, so what a
 * person sees before they turn the schedule on is exactly what it will send.
 */
export async function plannedNotifications(ctx: RequestContext, on = new Date()): Promise<Planned[]> {
  const out: Planned[] = []
  const today = dayKey(on)

  // ── invoices that are overdue, on the chasing cadence ──
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] },
      dueDate: { lt: today },
    },
    include: { customer: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  })
  const notes = await noteTotals(ctx.companyId, invoices.map((i) => i.id))

  for (const inv of invoices) {
    // 🔴 docs/86 — net of credit notes and of the TDS the client withholds, so an invoice
    // that has been credited or settled net of tax stops generating a reminder.
    const outstanding = invoiceOpen(inv, notes.get(inv.id) ?? NO_NOTES).collectible
    // 🔴 settled but not yet marked PAID — a rounding remainder or a status that has not
    // caught up. Chasing a client for ₹0.00 is the message that gets the sender ignored.
    if (outstanding.lte('1')) continue

    const days = Math.floor((today.getTime() - dayKey(inv.dueDate).getTime()) / DAY)
    if (!shouldChaseOverdue(days)) continue

    out.push({
      kind: 'INVOICE_OVERDUE',
      subjectId: inv.id,
      message: messages.invoiceOverdue(inv.number ?? 'An invoice', inv.customer.name, days, inv.id),
      roles: ['OWNER', 'ACCOUNTANT'],
    })
  }

  // ── compliance deadlines, a fortnight out and on the day ──
  const calendar = await complianceCalendar(ctx, on).catch(() => [])
  for (const item of calendar) {
    if (item.state === 'DONE' || item.state === 'NOT_APPLICABLE') continue
    // 🔴 three moments, not fourteen: a fortnight out so there is time to act, three days
    // out because that is when it becomes urgent, and the day itself.
    if (![14, 3, 0].includes(item.daysAway) && item.daysAway >= 0) continue
    // and once a week once it is late, rather than every morning for ever
    if (item.daysAway < 0 && Math.abs(item.daysAway) % 7 !== 0) continue

    out.push({
      kind: 'TAX_DUE',
      subjectId: item.id,
      message: {
        ...messages.taxDue(item.title, item.dueOn, item.daysAway < 0 ? -item.daysAway : 0),
        body: item.daysAway < 0
          ? `${Math.abs(item.daysAway)} days late — ${lowerFirst(item.penalty ?? item.detail)}`
          : `${item.detail}${item.penalty ? ` · ${item.penalty}` : ''}`,
        url: item.href ?? '/tax/calendar',
      },
      roles: ['OWNER', 'ACCOUNTANT'],
    })
  }

  // ── bills waiting on an approval, once a day while any are waiting ──
  // a bill awaiting approval is a DRAFT — the same thing /approvals counts
  const pending = await prisma.vendorBill.count({
    where: { companyId: ctx.companyId, status: 'DRAFT' },
  })
  if (pending > 0) {
    out.push({
      kind: 'APPROVAL_PENDING',
      // 🔴 the subject is the DAY, not a bill. One message about four bills, every day
      // there are any — not four messages, and not one per bill per day for ever.
      subjectId: 'bills',
      message: messages.approvalPending(pending),
      roles: ['OWNER'],
    })
  }

  return digestLargeGroups(out, today)
}

/** The penalty strings start lower-case; they follow a dash, not a full stop. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

const DIGEST_FROM = 3

/**
 * 🔴 Collapse a crowd into one message.
 *
 * Found by looking at a real morning's output: three separate pushes, one after another,
 * about the same overdue quarter — GSTR-3B, the GST payment and the TDS return. That is the
 * sequence that makes somebody turn notifications off for good, after which the system is
 * back to telling nobody anything, which is where this module started.
 *
 * One or two of a kind stay individual, because each carries a link worth following.
 */
function digestLargeGroups(planned: Planned[], today: Date): Planned[] {
  const byKind = new Map<string, Planned[]>()
  for (const p of planned) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p])

  const out: Planned[] = []
  for (const [kind, group] of byKind) {
    if (group.length < DIGEST_FROM || kind === 'APPROVAL_PENDING') { out.push(...group); continue }

    const what = kind === 'INVOICE_OVERDUE' ? 'invoices are overdue' : 'compliance deadlines need you'
    const url = kind === 'INVOICE_OVERDUE' ? '/reports/ageing' : '/tax/calendar'
    out.push({
      kind,
      // 🔴 keyed on the DAY, so the digest is sent once and a different crowd tomorrow is
      // a different message rather than a silent duplicate
      subjectId: `digest:${today.toISOString().slice(0, 10)}`,
      message: messages.digest(kind as never, what, group.map((g) => g.message.title), url),
      roles: group[0].roles,
    })
  }
  return out
}

export interface RunResult {
  planned: number
  sent: number
  alreadySent: number
  devices: number
  /** what went, in the order it went, so a run can be explained afterwards */
  log: { kind: string; subjectId: string; title: string; body: string; devices: number }[]
}

/**
 * Send what has not been sent today.
 *
 * 🔴 The log row is written in the SAME transaction-shaped step as the send, keyed on
 * (kind, subject, day). Two runs in the same minute — a cron that overlaps, a restart, a
 * person curling the endpoint to see what it does — must produce one notification, and the
 * unique constraint is what guarantees it rather than a check-then-act that races itself.
 */
export async function runNotifications(
  ctx: RequestContext, on = new Date(), opts: { dryRun?: boolean } = {},
): Promise<RunResult> {
  const planned = await plannedNotifications(ctx, on)
  const today = dayKey(on)

  const result: RunResult = { planned: planned.length, sent: 0, alreadySent: 0, devices: 0, log: [] }

  for (const p of planned) {
    if (opts.dryRun) continue

    // claim it first: if the row already exists this run has nothing to do
    try {
      await prisma.notificationLog.create({
        data: {
          companyId: ctx.companyId, kind: p.kind, subjectId: p.subjectId, forDay: today,
          title: p.message.title, body: p.message.body,
        },
      })
    } catch (e) {
      // 🔴 ONLY a unique-constraint violation means "already sent". A bare catch here would
      // treat a dropped connection as a duplicate, and the notification would never be sent
      // at all — silently, and only on the days the database happened to hiccup.
      if ((e as { code?: string }).code === 'P2002') { result.alreadySent += 1; continue }
      throw e
    }

    const sendResult = await pushToCompany(ctx.companyId, p.message, p.roles)
    await prisma.notificationLog.updateMany({
      where: { companyId: ctx.companyId, kind: p.kind, subjectId: p.subjectId, forDay: today },
      data: { recipients: sendResult.sent },
    })

    result.sent += 1
    result.devices += sendResult.sent
    result.log.push({
      kind: p.kind, subjectId: p.subjectId,
      title: p.message.title, body: p.message.body, devices: sendResult.sent,
    })
  }

  return result
}

/** What has gone out, for the screen that shows whether any of this is working. */
export async function recentNotifications(ctx: RequestContext, limit = 30) {
  return prisma.notificationLog.findMany({
    where: { companyId: ctx.companyId }, orderBy: { sentAt: 'desc' }, take: limit,
  })
}

/** A one-line summary for the screen — mostly, whether anything can be delivered at all. */
export async function deliveryStanding(ctx: RequestContext) {
  const [devices, lastRun, total] = await Promise.all([
    prisma.pushSubscription.count({
      where: { failedAt: null, user: { companies: { some: { companyId: ctx.companyId } } } },
    }),
    prisma.notificationLog.findFirst({ where: { companyId: ctx.companyId }, orderBy: { sentAt: 'desc' } }),
    prisma.notificationLog.count({ where: { companyId: ctx.companyId } }),
  ])
  return { devices, lastRun: lastRun?.sentAt ?? null, total }
}
