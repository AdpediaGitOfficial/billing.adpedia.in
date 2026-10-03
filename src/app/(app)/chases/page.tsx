import { requireContext } from '@/server/context'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Pill, Alert, Empty } from '@/components/ui/kit'
import { outstandingChases, chaseHistory, chaseTotals } from '@/server/services/compliance/chases'
import { ChaseCard } from './chase-card'

const GROUPS: { kinds: string[]; title: string; sub: string }[] = [
  { kinds: ['PAN_NUMBER', 'PAN_CARD'], title: 'PAN',
    sub: 'Without a number, s.206AA forces 20% — money the payee only gets back by filing a return' },
  { kinds: ['GSTR1_NOT_FILED'], title: 'Suppliers who have not declared our invoice',
    sub: 's.16(2)(aa) — the credit is not available until it appears in our GSTR-2B' },
  { kinds: ['TDS_CREDIT'], title: 'Tax deducted from us that is not in our 26AS',
    sub: 'Until it appears it cannot be claimed, so it is a cost rather than a timing difference' },
  { kinds: ['FORM_16A'], title: 'Certificates downloaded and not sent',
    sub: 'Rule 31(1) — the deductee needs it to claim the credit' },
  { kinds: ['INVOICE_OVERDUE'], title: 'Money owed to us',
    sub: 'Past the due date, with the amount still outstanding' },
]

export default async function ChasesPage() {
  const ctx = await requireContext()
  const [chases, history] = await Promise.all([outstandingChases(ctx), chaseHistory(ctx)])
  const totals = chaseTotals(chases)

  const view = chases.map((c) => ({
    kind: c.kind, subjectId: c.subjectId, partyName: c.partyName,
    email: c.email, phone: c.phone, why: c.why, subject: c.subject, body: c.body,
    lastAskedAt: c.lastAskedAt ? c.lastAskedAt.toISOString().slice(0, 10) : null,
    amount: c.amount ? c.amount.toFixed(2) : null,
  }))

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Chases"
        sub="Everything this system is waiting on somebody else for, with the words already written" />

      <Alert tone="info" title="Nothing here sends anything">
        The message goes from your own address, under your own name, because that is where the
        relationship is — a chase from an automated address is the one that gets ignored. What this
        does is know who to ask, what to ask for and what it is costing them, and then record that
        you asked.
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="To ask" value={String(totals.count)} icon="MessageSquare"
          tone={totals.count > 0 ? 'accent' : 'default'}
          foot={totals.neverAsked > 0 ? `${totals.neverAsked} never asked at all` : 'All of them have been asked once'} />
        <StatCard label="Over-withheld for want of a PAN" value={formatINR(totals.overWithheld, { decimals: false })}
          icon="UserX" foot="s.206AA — 20% instead of the section rate" />
        <StatCard label="GST credit we cannot take" value={formatINR(totals.creditBlocked.plus(totals.unclaimedCredit), { decimals: false })}
          icon="FileWarning" foot="Suppliers who have not filed, and TDS missing from our 26AS" />
        <StatCard label="Owed to us" value={formatINR(totals.owedToUs, { decimals: false })}
          icon="HandCoins" foot="Invoices past their due date" />
      </div>

      {chases.length === 0 && (
        <Card><Empty icon="CheckCircle2" title="Nothing to chase"
          hint="Every PAN is on file with its card, every certificate has gone out, every deduction is in the 26AS and nothing is overdue." /></Card>
      )}

      {GROUPS.map((g) => {
        const rows = view.filter((c) => g.kinds.includes(c.kind))
        if (rows.length === 0) return null
        return (
          <section key={g.title} className="space-y-3">
            <div>
              <p className="text-[15px] font-semibold">{g.title}</p>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{g.sub}</p>
            </div>
            {rows.map((c) => <ChaseCard key={`${c.kind}:${c.subjectId}`} chase={c} />)}
          </section>
        )
      })}

      <Card flush className="overflow-hidden">
        <CardHeader title="What has been asked" className="p-5 pb-3"
          sub="The words as they were sent — “we chased them” is an assertion, this is the thing you can produce" />
        {history.length === 0 ? (
          <Empty icon="Inbox" title="Nothing recorded yet"
            hint="Send one of the messages above, then press “I sent this”. It is never recorded automatically — opening a mail composer is not the same as sending." />
        ) : (
          <table className="w-full text-[12.5px]">
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                  <td className="px-5 py-2.5">
                    <span className="font-medium">{h.partyName}</span>
                    <span className="mt-0.5 block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      {h.sentTo}
                    </span>
                  </td>
                  <td className="py-2.5"><Pill tone="neutral">{h.channel.toLowerCase()}</Pill></td>
                  <td className="px-5 py-2.5 text-right tabular" style={{ color: 'var(--text-muted)' }}>
                    {h.sentAt.toISOString().slice(0, 10)}
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
