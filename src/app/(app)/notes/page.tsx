import Link from 'next/link'
import { requireContext } from '@/server/context'
import { listCreditNotes } from '@/server/services/invoicing/credit-note'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { Card, PageHeader, StatCard, Pill, Empty, Alert, DataTable, Button, type Column } from '@/components/ui/kit'
import type { SwipeSpec } from '@/components/ui/swipe'

/**
 * The credit and debit note register — docs/69.
 *
 * 🔴 One list, not two. They share a table and differ by `noteType` because they are the same
 * document taken in opposite directions, and what somebody comes here to see is the pair: how
 * much has been credited away against how much has been charged back.
 *
 * Each note still belongs to its invoice, which is where it is raised and where it is
 * cancelled. This is the register — the series as a series, which docs/48 §5 noted was
 * missing and which `/settings/series` only ever showed the NUMBERING of.
 */
export default async function NotesPage() {
  const ctx = await requireContext()
  const notes = await listCreditNotes(ctx)

  const live = notes.filter((n) => !n.cancelledAt)
  const credits = live.filter((n) => n.noteType === 'CREDIT')
  const debits = live.filter((n) => n.noteType === 'DEBIT')
  const sum = (rows: typeof live) => rows.reduce((a, n) => a.plus(n.grandTotal.toString()), ZERO as Decimal)

  /**
   * 🔴 The tax that could not be recovered. A credit note raised past the s.34(2) deadline
   * still credits the client the same gross and recovers no GST — the money is gone, and it is
   * the one figure on this page that is a loss rather than a movement (`docs/48 §1`).
   */
  const unrecovered = live.reduce((a, n) => a.plus(n.taxNotAdjusted.toString()), ZERO as Decimal)

  type Row = (typeof notes)[number]
  const cols: Column<Row>[] = [
    { key: 'number', header: 'Note', width: '16%', mobile: 'primary',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold tabular"
            style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            {r.number}
          </span>
          <Pill tone={r.noteType === 'DEBIT' ? 'accent' : 'neutral'}>
            {r.noteType === 'DEBIT' ? 'debit' : 'credit'}
          </Pill>
        </span>
      ) },
    { key: 'against', header: 'Against', mobile: 'secondary',
      cell: (r) => (
        <>
          {r.invoice
            ? <Link href={`/invoices/${r.invoice.id}`} className="hover:underline">{r.invoice.number}</Link>
            : <span style={{ color: 'var(--text-muted)' }}>no invoice</span>}
          <span className="block text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {r.invoice?.customer.name ?? r.reason}
          </span>
        </>
      ) },
    { key: 'date', header: 'Note date', width: '11%', mobile: false,
      cell: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.date.toISOString().slice(0, 10)}</span> },
    /**
     * 🔴 A column of its own, on the card as well as the table.
     *
     * The s.34(2) clock runs from the INVOICE, not the note, and they come apart whenever a
     * note is raised in a later year (docs/66 §1). It was a suffix on the customer's name
     * first, and on a phone the name ate the width and truncated away the only part that
     * carried the rule — the same mistake as docs/68 §7's `₹7,43,40…`, in a different column.
     */
    { key: 'invoiced', header: 'Invoiced', width: '11%', mobile: 'secondary',
      cell: (r) => r.invoice
        ? <span style={{ color: 'var(--text-muted)' }}>invoiced {r.invoice.date.toISOString().slice(0, 10)}</span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span> },
    { key: 'reason', header: 'Reason', width: '18%', mobile: false,
      cell: (r) => <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{r.reason}</span> },
    { key: 'tax', header: 'GST', width: '15%', align: 'center', mobile: 'tag',
      cell: (r) => r.cancelledAt
        ? <Pill tone="neutral">cancelled</Pill>
        : r.noteType === 'DEBIT'
          ? <Pill tone="accent" dot>charged</Pill>
          : r.gstAdjusted
            ? <Pill tone="good" dot>adjusted</Pill>
            // 🔴 not a style choice: past s.34(2) the gross still goes back and the tax does not
            : <Pill tone="warn" dot>none — s.34(2)</Pill> },
    { key: 'total', header: 'Amount', width: '15%', align: 'right', mobile: 'value',
      cell: (r) => (
        <>
          <span className="block font-semibold"
            style={r.cancelledAt ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            {formatINR(r.grandTotal.toString())}
          </span>
          {r.amendments.length > 0 && (
            <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
              amended in {r.amendments[0].periodLabel}
            </span>
          )}
        </>
      ) },
  ]

  /** The note lives on its invoice — that is where it is raised, amended and cancelled. */
  const swipe = (r: Row): SwipeSpec | undefined => r.invoice
    ? {
        right: { kind: 'link', label: 'Invoice', legend: 'for the invoice behind it', icon: 'FileText',
          tone: 'info', href: `/invoices/${r.invoice.id}` },
        left: { kind: 'link', label: 'Document', legend: 'for the note itself', icon: 'Download',
          tone: 'accent', href: `/api/credit-notes/${r.id}/document` },
      }
    : undefined

  return (
    <div>
      <PageHeader title="Credit &amp; debit notes"
        sub={`${live.length} issued${notes.length > live.length ? ` · ${notes.length - live.length} cancelled` : ''}`}
        action={<Link href="/invoices"><Button variant="ghost" icon="FileText">Go to an invoice</Button></Link>} />

      {notes.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Credited away" value={formatINR(sum(credits), { decimals: false })} icon="ArrowDownLeft"
            foot={`${credits.length} credit note${credits.length === 1 ? '' : 's'} · s.34(1)`} />
          <StatCard label="Charged back" value={formatINR(sum(debits), { decimals: false })} icon="ArrowUpRight"
            foot={`${debits.length} debit note${debits.length === 1 ? '' : 's'} · s.34(3), no deadline`} />
          <StatCard label="GST not recovered" value={formatINR(unrecovered, { decimals: false })} icon="FileWarning"
            tone={unrecovered.gt(0) ? 'accent' : 'default'}
            foot={unrecovered.gt(0) ? 'past s.34(2) — the client was credited, the tax was not' : 'every note recovered its tax'} />
          <StatCard label="Amended" value={String(live.filter((n) => n.amendments.length > 0).length)} icon="RefreshCw"
            foot="reported again in table 9C" />
        </div>
      )}

      {unrecovered.gt(0) && (
        <div className="mb-4">
          <Alert tone="warn" title={`${formatINR(unrecovered)} of GST was credited away without being recovered`}>
            s.34(2) allows the output tax on a credit note to be reduced only until 30 November following the
            financial year of the <em>invoice</em>. Past that the note is still good between the parties — the
            client is credited the same gross — but the tax stays paid, it is not reported in GSTR-1, and the
            document says so on its face.
          </Alert>
        </div>
      )}

      <Card flush className="overflow-hidden">
        <DataTable columns={cols} rows={notes} keyOf={(r) => r.id} swipe={swipe} noun="notes"
          empty={<Empty icon="FileStack" title="No credit or debit notes yet"
            hint="They are raised from the invoice they adjust, which is the only place they belong. This is the register — the series as a series, rather than one invoice at a time." />} />
      </Card>

      <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {/* 🔴 The rule, not a worked example. The first version picked one note and printed its
            deadline under a general heading, which reads as THE deadline — and the whole point
            of the rule is that every invoice has its own. */}
        A credit note may reduce output tax only until 30 November following the financial year of the{' '}
        <em>invoice</em> — s.34(2), which is why the invoice&rsquo;s own date is on each row above. A March
        supply is in the same financial year as the previous April, so that window is sometimes much
        shorter than a year. A debit note has no such deadline: s.34 time-bars only the relief that
        reduces the government&rsquo;s tax.
      </p>
    </div>
  )
}
