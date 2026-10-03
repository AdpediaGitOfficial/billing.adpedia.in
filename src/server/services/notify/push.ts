import webpush from 'web-push'
import { prisma } from '@/server/db'
import { formatINR } from '@/lib/money'
import type { Decimal } from '@/lib/money'

/**
 * Web push.
 *
 * 🔴 A notification carries only what is already implied by the event, never a figure the
 * recipient would otherwise have to open the app to see in context. Push payloads land on
 * a lock screen, visible to anyone holding the phone, and they pass through a third-party
 * push service on the way. "Payment received from Click AR" is fine; the company's cash
 * position is not.
 */

let configured: boolean | null = null

function ensureConfigured(): boolean {
  if (configured !== null) return configured
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:accounts@adpedia.in'
  if (!publicKey || !privateKey) { configured = false; return false }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  configured = true
  return true
}

export type NotificationKind = 'PAYMENT_RECEIVED' | 'APPROVAL_PENDING' | 'TAX_DUE' | 'INVOICE_OVERDUE'

export interface PushMessage {
  kind: NotificationKind
  title: string
  body: string
  url?: string
}

export interface SendResult { sent: number; pruned: number; skipped: boolean }

/**
 * Send to every live device for a user.
 *
 * A push service answering 404 or 410 means the subscription is permanently gone — the
 * browser was uninstalled, the user cleared data. That row is marked failed rather than
 * retried forever, because a dead endpoint otherwise slows every later send.
 */
export async function pushToUser(userId: string, msg: PushMessage): Promise<SendResult> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0, skipped: true }

  const subs = await prisma.pushSubscription.findMany({ where: { userId, failedAt: null } })
  if (subs.length === 0) return { sent: 0, pruned: 0, skipped: false }

  const payload = JSON.stringify({
    title: msg.title, body: msg.body, url: msg.url ?? '/dashboard', tag: msg.kind,
  })

  let sent = 0, pruned = 0
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      )
      sent += 1
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { failedAt: new Date() } })
        pruned += 1
      }
      // anything else is transient — leave the subscription alone
    }
  }))

  return { sent, pruned, skipped: false }
}

/** Everyone in the company who can act on this kind of event. */
export async function pushToCompany(companyId: string, msg: PushMessage, roles?: string[]): Promise<SendResult> {
  const members = await prisma.userCompany.findMany({
    where: { companyId, ...(roles ? { role: { in: roles as never[] } } : {}) },
    select: { userId: true },
  })
  const results = await Promise.all(members.map((m) => pushToUser(m.userId, msg)))
  return results.reduce<SendResult>(
    (a, r) => ({ sent: a.sent + r.sent, pruned: a.pruned + r.pruned, skipped: a.skipped && r.skipped }),
    { sent: 0, pruned: 0, skipped: true },
  )
}

/* ── The four events from docs/13 §4, as message builders ─────────────────────── */

export const messages = {
  paymentReceived: (customer: string, amount: Decimal | string, invoiceId: string): PushMessage => ({
    kind: 'PAYMENT_RECEIVED',
    title: 'Payment received',
    body: `${formatINR(amount)} from ${customer}`,
    url: `/invoices/${invoiceId}`,
  }),

  approvalPending: (count: number): PushMessage => ({
    kind: 'APPROVAL_PENDING',
    title: count === 1 ? 'A bill needs approval' : `${count} bills need approval`,
    body: 'They cannot be paid or claimed until approved.',
    url: '/bills',
  }),

  // 🔴 "is due" over a body reading "70 days late" is the sort of thing that makes a person
  // stop reading the notifications. The title follows the fact.
  taxDue: (what: string, dueOn: Date, daysLate = 0): PushMessage => ({
    kind: 'TAX_DUE',
    title: daysLate > 0 ? `${what} is overdue` : `${what} is due`,
    body: `Due ${dueOn.toISOString().slice(0, 10)}. Late deposit carries interest per month or part of a month.`,
    url: '/tax/tds',
  }),

  /**
   * 🔴 One message instead of several of the same kind — docs/60.
   *
   * Three pushes in one morning about one overdue quarter is how a person turns
   * notifications off, and then never hears the one that mattered. Past a couple, they
   * become a single line that says how many and names the first few.
   */
  digest: (kind: NotificationKind, what: string, items: string[], url: string): PushMessage => ({
    kind,
    title: `${items.length} ${what}`,
    body: items.slice(0, 3).join(' · ') + (items.length > 3 ? ` · and ${items.length - 3} more` : ''),
    url,
  }),

  invoiceOverdue: (number: string, customer: string, days: number, invoiceId: string): PushMessage => ({
    kind: 'INVOICE_OVERDUE',
    title: `${number} is ${days} days overdue`,
    body: customer,
    url: `/invoices/${invoiceId}`,
  }),
}
