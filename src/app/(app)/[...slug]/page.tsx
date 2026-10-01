import Link from 'next/link'
import { notFound } from 'next/navigation'
import { NAV } from '@/components/shell/nav'
import { Card, PageHeader, Button, Pill } from '@/components/ui/kit'
import { Icon } from '@/components/shell/icon'

/**
 * Routes that exist in the navigation but belong to a later phase.
 * A dead link is worse than an honest one — this says what lands, and when.
 */
const ROADMAP: Record<string, { phase: number; title: string; summary: string; bullets: string[] }> = {
  '/projects':              { phase: 1, title: 'Projects', summary: 'Project records exist and invoices already carry one — this is the screen to manage them.', bullets: ['Create and edit projects against a customer', 'Contract value, milestones and status', 'Project P&L once costs land in phase 4'] },
  '/receipts':              { phase: 1, title: 'Receipts', summary: 'Receipts post correctly today; this is the screen to record them by hand.', bullets: ['Allocate one receipt across several invoices', 'Capture the TDS a client deducted', 'Bank charges and forex difference on inward remittances'] },
  '/tax/gst':               { phase: 2, title: 'GST', summary: 'Output and input ledgers, the LUT register, and returns prepared for your CA.', bullets: ['GSTR-1 and GSTR-3B export, not portal filing', 'HSN/SAC summary', 'QRMP-aware periods'] },
  '/accounting/accounts':   { phase: 1, title: 'Chart of accounts', summary: '55 accounts are seeded and in use; this is the screen to view and extend them.', bullets: ['System accounts are locked — posting rules reference them by code', 'Add your own sub-accounts', 'Balances per account per period'] },
  '/accounting/journal':    { phase: 1, title: 'Journal', summary: 'Every posting the system has made, and manual entries.', bullets: ['Drill from any document to the entry behind it', 'Reversals, never edits', 'Period lock enforced on every path'] },
  '/accounting/trial-balance': { phase: 8, title: 'Trial balance', summary: 'Debits and credits by account, which must agree by construction.', bullets: ['Per period and per financial year', 'Drill through to the entries', 'The basis for the P&L and balance sheet'] },
  '/reports/pnl':           { phase: 8, title: 'Profit & loss', summary: 'Revenue less costs, drillable to the journal line.', bullets: ['Monthly and year to date', 'Comparative against the prior year', 'Export for your CA'] },
  '/settings/company':      { phase: 1, title: 'Company settings', summary: 'Legal identity, branding, series and LUT register.', bullets: ['Everything is seeded and live today', 'LUT register with the per-year validity guard', 'Invoice series and numbering format'] },
  '/settings/users':        { phase: 0, title: 'Users & roles', summary: 'Five roles are enforced server-side already; this is the screen to manage them.', bullets: ['Owner, accountant, project manager, employee, auditor', 'Auditor is read-only by construction', 'TOTP for owner and accountant'] },
  '/approvals':             { phase: 3, title: 'Approvals', summary: 'The owner queue — bills, expenses and anything else awaiting sign-off.', bullets: ['Vendor bills over a threshold', 'Expense claims', 'Push notification on mobile'] },
  '/more':                  { phase: 1, title: 'More', summary: 'Everything that does not earn a slot in the mobile tab bar.', bullets: [] },
}

export default async function RoadmapPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  const href = '/' + slug.join('/')
  const entry = ROADMAP[href]
  if (!entry) notFound()

  const known = NAV.flatMap((g) => g.items).find((i) => i.href === href)

  return (
    <div className="max-w-2xl">
      <PageHeader title={entry.title} sub={entry.summary} />
      <Card>
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Icon name={known?.icon ?? 'Construction'} size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[15px] font-semibold">Arriving in phase {entry.phase}</p>
              <Pill tone={entry.phase <= 1 ? 'good' : 'accent'}>
                {entry.phase <= 1 ? 'Partly live' : `Phase ${entry.phase}`}
              </Pill>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              The data model, posting rules and guards for this area are already in place — what is
              missing is the screen.
            </p>
            {entry.bullets.length > 0 && (
              <ul className="mt-4 space-y-2">
                {entry.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                    <Icon name="Check" size={14} strokeWidth={2.4} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
                    {b}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5 flex gap-2">
              <Link href="/dashboard"><Button variant="ghost" icon="ArrowLeft">Back to dashboard</Button></Link>
              <Link href="/invoices"><Button variant="soft">Go to invoices</Button></Link>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
