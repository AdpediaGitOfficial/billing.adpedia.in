import Link from 'next/link'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, Pill, Empty, Button, DataTable, Alert, type Column, statGrid, StatCard, tapTarget } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'
import type { PartyLedger, PartyLedgerLine } from '@/server/services/reports/party-ledger'
import type { ResolvedPeriod } from '@/server/services/reports/period'

/**
 * One running account — docs/84.
 *
 * 🔴 One component for both parties. A client statement and a vendor statement are the same
 * document with the sign the other way up, and two copies of it would drift: docs/58's lesson
 * is that a statement which disagrees with itself is worse than no statement, and two
 * renderers of the same numbers is the cheapest way to get there.
 */
export function PartyLedgerView({ led, period, back, csvHref, periodHref }: {
  led: PartyLedger
  period: ResolvedPeriod
  back: { href: string; label: string }
  csvHref: string
  /** the same page, for another financial year */
  periodHref: (fyId: string) => string
}) {
  const isClient = led.party.kind === 'CUSTOMER'
  /**
   * 🔴 What a positive closing balance MEANS, said in words on the screen.
   *
   * The same number is an asset on a client and a liability on a vendor, and a statement that
   * only prints "₹2,95,000" leaves the reader to work out which. It is also the figure that
   * gets read out on a phone call.
   */
  const direction = isClient ? 'owed to us' : 'owed by us'
  const settled = led.closing.isZero()

  const cols: Column<PartyLedgerLine>[] = [
    { key: 'date', header: 'Date', width: '11%', mobile: 'secondary',
      cell: (l) => <span style={{ color: 'var(--text-secondary)' }}>{l.date.toISOString().slice(0, 10)}</span> },
    { key: 'what', header: 'Entry', mobile: 'primary',
      cell: (l) => (
        <>
          <span className="block">{l.lineNarration ?? l.narration}</span>
          {/* 🔴 the other side of the entry. A receipt credits AR once for cash PLUS the TDS
              withheld, so without this the row says ₹1,18,000 and nothing says ₹10,000 of it
              was never cash. */}
          {l.contra.length > 0 && (
            <span className="mt-0.5 block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {l.contra.map((c) => `${c.name} ${formatINR(c.amount, { decimals: false })}`).join(' · ')}
            </span>
          )}
        </>
      ) },
    { key: 'account', header: 'Account', width: '14%', mobile: false,
      cell: (l) => <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.accountCode}</span> },
    { key: 'debit', header: 'Debit', width: '13%', align: 'right', mobile: false,
      cell: (l) => <span>{l.debit.isZero() ? '—' : formatINR(l.debit)}</span> },
    { key: 'credit', header: 'Credit', width: '13%', align: 'right', mobile: false,
      cell: (l) => <span>{l.credit.isZero() ? '—' : formatINR(l.credit)}</span> },
    { key: 'balance', header: 'Balance', width: '15%', align: 'right', mobile: 'value',
      cell: (l) => <span className="font-semibold">{formatINR(l.balance)}</span> },
  ]

  return (
    <div>
      <PageHeader back={back} title={led.party.name}
        sub={[led.party.subtitle, period.label].filter(Boolean).join(' · ')}
        action={
          <div className="flex flex-wrap gap-2">
            <a href={csvHref} download>
              <Button variant="ghost" icon="Download">CSV</Button>
            </a>
          </div>
        } />

      {period.options.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1">
          {period.options.map((o) => (
            <Link key={o.id} href={periodHref(o.id)}
              className={`rounded-lg px-3 text-[12.5px] font-semibold transition-colors ${tapTarget}`}
              style={o.id === period.fyId
                ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' }
                : { color: 'var(--text-secondary)' }}>
              {o.label}
            </Link>
          ))}
        </div>
      )}

      {/* 🔴 docs/84, narrowed by docs/91 — only documents booked WITHOUT a rate land here: ones
          sent before rates were captured, which posted their dollars at face value. A foreign
          invoice with a rate is rupees in the ledger and is not mixed. */}
      {led.foreignCurrency.length > 0 && (
        <div className="mb-5">
          <Alert tone="critical" title="This balance mixes currencies">
            {led.foreignCurrency.map((f) => `${f.count} document${f.count === 1 ? '' : 's'} in ${f.currency}`).join(', ')}
            {' '}in {period.label} were booked with no exchange rate, so they were posted to the rupee
            control account at their own face value — the figures below add dollars to rupees.
            The same applies to the trial balance and the balance sheet for those documents.
            Treat this statement as a list of entries, not as a total, until they are re-booked
            at a rate.
          </Alert>
        </div>
      )}

      <div className={`${statGrid} mb-5 sm:grid-cols-2 lg:grid-cols-4`}>
        <StatCard label="Opening" value={formatINR(led.opening, { decimals: false })} icon="Scale"
          foot={`Brought into ${period.label}`} />
        <StatCard label="Debited" value={formatINR(led.debit, { decimals: false })} icon="ArrowUpRight"
          foot={isClient ? 'Invoiced and advances absorbed' : 'Paid and TDS withheld'} />
        <StatCard label="Credited" value={formatINR(led.credit, { decimals: false })} icon="ArrowDownLeft"
          foot={isClient ? 'Received and advances held' : 'Billed'} />
        <StatCard label="Closing" value={formatINR(led.closing, { decimals: false })} icon="Wallet"
          tone="accent" foot={settled ? 'Settled' : direction} />
      </div>

      <Card flush className="overflow-hidden">
        <CardHeader className="p-5 pb-3"
          title={isClient ? 'Receivable and advances held' : 'Payable'}
          sub={led.accounts.map((a) => `${a.code} ${a.name}`).join('  +  ')}
          action={<Pill tone={settled ? 'good' : isClient ? 'warn' : 'accent'} dot>
            {settled ? 'settled' : `${formatINR(led.closing, { decimals: false })} ${direction}`}
          </Pill>} />

        <DataTable columns={cols} rows={led.lines} keyOf={(l) => l.id} noun="entries"
          empty={<Empty icon="BookOpen" title={`Nothing posted in ${period.label}`}
            hint={led.opening.isZero()
              ? 'No invoice, bill, receipt or payment has touched this account for them in this year.'
              : `They came into the year at ${formatINR(led.opening)} ${direction}, and nothing has moved since.`} />} />

        {led.lines.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[12.5px]"
            style={{ borderTop: '1px solid var(--rule)' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              Opening {formatINR(led.opening)} · {led.lines.length} {led.lines.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="tabular font-semibold">
              Closing {formatINR(led.closing)} <span className="font-normal" style={{ color: 'var(--text-muted)' }}>{direction}</span>
            </span>
          </div>
        )}
      </Card>

      {/* 🔴 docs/84 — what this statement deliberately leaves out, where the reader will
          otherwise go looking for it. The GST on an advance is credited to the output tax
          account, not to 2400, so an advance appears here at its taxable value. Saying so is
          cheaper than a reader reconciling it by hand and concluding the ledger is wrong. */}
      {isClient && (
        <p className="mt-3 flex items-start gap-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          <Icon name="Info" size={13} strokeWidth={2} />
          <span>
            An advance shows at its taxable value. The GST declared on it is booked to the output
            tax account, not to 2400, so it is not part of this balance.
          </span>
        </p>
      )}
    </div>
  )
}
