import Link from 'next/link'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Button, Empty, statGrid } from '@/components/ui/kit'
import { plannedNotifications, recentNotifications, deliveryStanding } from '@/server/services/notify/schedule'

const KIND_LABEL: Record<string, string> = {
  INVOICE_OVERDUE: 'Overdue invoice',
  TAX_DUE: 'Compliance deadline',
  APPROVAL_PENDING: 'Waiting for approval',
  PAYMENT_RECEIVED: 'Payment received',
}

export default async function RemindersPage() {
  const ctx = await requireContext()
  assertCan(ctx.role, 'settings.company', 'read')

  const [planned, recent, standing] = await Promise.all([
    plannedNotifications(ctx),
    recentNotifications(ctx),
    deliveryStanding(ctx),
  ])

  const scheduled = Boolean(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16)

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Reminders"
        sub="What this system would tell you, and whether anything can reach you"
        action={<Link href="/settings/device"><Button variant="ghost">This device</Button></Link>} />

      {/* 🔴 docs/60 — the failure nobody discovers until an invoice is ninety days late */}
      {standing.devices === 0 && (
        <Alert tone="critical" title="Nothing can be delivered"
          action={<Link href="/settings/device"><Button size="sm" variant="ghost">Turn them on</Button></Link>}>
          No device has notifications switched on, so every reminder below is computed and goes
          nowhere. Notifications are per device and per browser — turning them on once, on one
          phone, is what makes any of this real.
        </Alert>
      )}

      {!scheduled && (
        <Alert tone="warn" title="No schedule is configured">
          The reminders below are worked out live, and nothing is running to send them. A Next.js
          app has no scheduler of its own — set <code>CRON_SECRET</code> in the environment and have
          something call the endpoint once a day:
          <code className="mt-1.5 block font-mono text-[11.5px]">
            curl -X POST -H &quot;Authorization: Bearer $CRON_SECRET&quot; https://&lt;host&gt;/api/cron/notify
          </code>
        </Alert>
      )}

      <div className={`${statGrid} sm:grid-cols-3`}>
        <StatCard label="Would send today" value={String(planned.length)} icon="BellRing"
          tone={planned.length > 0 ? 'accent' : 'default'}
          foot={planned.length === 0 ? 'Nothing is due or overdue' : 'Worked out live, every time'} />
        <StatCard label="Devices listening" value={String(standing.devices)} icon="Smartphone"
          foot={standing.devices === 0 ? 'Nobody has them switched on' : 'Across everyone in the company'} />
        <StatCard label="Sent so far" value={String(standing.total)} icon="Send"
          foot={standing.lastRun ? `Last ${standing.lastRun.toISOString().slice(0, 16).replace('T', ' ')}` : 'Nothing has ever been sent'} />
      </div>

      <Card flush className="overflow-hidden">
        <CardHeader title="What would go out today" className="p-5 pb-3"
          sub="Computed now, from live data — never prepared in advance" />
        <div className="px-5 pb-4">
          {planned.length === 0 ? (
            <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Nothing today. Overdue invoices are chased on the first day, then at a week, a
              fortnight and monthly — not every morning, which is how a person ends up turning
              notifications off and missing the one that mattered.
            </p>
          ) : (
            <ul className="space-y-2">
              {planned.map((p) => (
                <li key={`${p.kind}:${p.subjectId}`} className="rounded-lg px-3 py-2.5" style={{ background: 'var(--surface)' }}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{p.message.title}</span>
                    <Pill tone="neutral">{KIND_LABEL[p.kind] ?? p.kind}</Pill>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {p.message.body}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card flush className="overflow-hidden">
        <CardHeader title="What has been sent" className="p-5 pb-3"
          sub="Kept so the same reminder is never sent twice, whatever runs the schedule" />
        {recent.length === 0 ? (
          <Empty icon="Inbox" title="Nothing has been sent yet"
            hint="Once the schedule runs, every message appears here with the day it was about and how many devices it reached." />
        ) : (
          <table className="w-full text-[12.5px]">
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-5 py-2.5">
                    <span className="font-medium">{r.title}</span>
                    <span className="mt-0.5 block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{r.body}</span>
                  </td>
                  <td className="py-2.5 tabular" style={{ color: 'var(--text-muted)' }}>
                    {r.forDay.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {r.recipients === 0
                      ? <Pill tone="warn">reached nobody</Pill>
                      : <Pill tone="good" dot>{r.recipients} device{r.recipients === 1 ? '' : 's'}</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
