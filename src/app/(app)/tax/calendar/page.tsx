import Link from 'next/link'
import { requireContext } from '@/server/context'
import { complianceCalendar, type CalendarItem } from '@/server/services/compliance/calendar'
import { formatINR } from '@/lib/money'
import { PageHeader, Card, Pill, StatCard, Empty, Alert, statGrid } from '@/components/ui/kit'

const TONE = {
  OVERDUE: 'critical', SOON: 'warn', DUE: 'neutral', DONE: 'good', NOT_APPLICABLE: 'neutral',
} as const

const LABEL = {
  OVERDUE: 'overdue', SOON: 'due soon', DUE: 'scheduled', DONE: 'done', NOT_APPLICABLE: 'not applicable',
} as const

export default async function CalendarPage() {
  const ctx = await requireContext()
  const items = await complianceCalendar(ctx)

  const overdue = items.filter((i) => i.state === 'OVERDUE')
  const soon = items.filter((i) => i.state === 'SOON')
  const later = items.filter((i) => i.state === 'DUE')
  const settled = items.filter((i) => i.state === 'DONE' || i.state === 'NOT_APPLICABLE')

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Compliance calendar"
        sub="What is actually due, derived from the books — not a list of dates." />

      <div className={`${statGrid} sm:grid-cols-3`}>
        <StatCard label="Overdue" value={String(overdue.length)} tone={overdue.length > 0 ? 'accent' : 'default'} />
        <StatCard label="Due within 14 days" value={String(soon.length)} />
        <StatCard label="Settled" value={String(settled.length)} foot="done or not applicable" />
      </div>

      {overdue.length === 0 && soon.length === 0 && (
        <Alert tone="good" title="Nothing due in the next fortnight">
          Items appear here only when there is something to do — TDS to deposit because
          deductions are unlinked, a return to file because the period has supplies in it. A
          calendar that printed every statutory date every month would be noise within a
          fortnight, and then the one that mattered would be missed too.
        </Alert>
      )}

      {items.length === 0 ? (
        <Card><Empty icon="CalendarClock" title="No open financial year"
          hint="The calendar is built from the open year's transactions." /></Card>
      ) : (
        <>
          <Section title="Overdue" items={overdue} />
          <Section title="Next 14 days" items={soon} />
          <Section title="Later this year" items={later} />
          <Section title="Settled" items={settled} muted />
        </>
      )}
    </div>
  )
}

function Section({ title, items, muted }: { title: string; items: CalendarItem[]; muted?: boolean }) {
  if (items.length === 0) return null
  return (
    <Card flush className="overflow-hidden">
      <div className="border-b px-4 py-2.5" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
        <span className="eyebrow">{title}</span>
      </div>
      {items.map((i) => (
        <div key={i.id} className="border-t px-4 py-3" style={{ borderColor: 'var(--rule)', opacity: muted ? 0.65 : 1 }}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                {i.href ? <Link href={i.href} className="hover:underline">{i.title}</Link> : i.title}
              </p>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{i.detail}</p>
            </div>
            <div className="shrink-0 text-right">
              <Pill tone={TONE[i.state]}>{LABEL[i.state]}</Pill>
              <p className="mt-1 text-[11.5px] tabular" style={{ color: 'var(--text-muted)' }}>
                {i.dueOn.toISOString().slice(0, 10)}
                {i.state === 'OVERDUE' && ` · ${Math.abs(i.daysAway)}d late`}
                {i.state === 'SOON' && ` · ${i.daysAway}d`}
              </p>
            </div>
          </div>

          {i.amount && !i.amount.isZero() && (
            <p className="mt-1.5 text-[12px] font-medium tabular">{formatINR(i.amount)}</p>
          )}

          {/* what being late actually costs — shown on the ones that are, not on every row */}
          {i.penalty && (i.state === 'OVERDUE' || i.state === 'SOON') && (
            <p className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px]"
              style={{ background: 'var(--surface)', color: i.state === 'OVERDUE' ? 'var(--critical)' : 'var(--text-muted)' }}>
              {i.penalty}
            </p>
          )}
        </div>
      ))}
    </Card>
  )
}
