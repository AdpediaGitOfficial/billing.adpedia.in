import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { can } from '@/server/auth/permissions'
import { Card, PageHeader, StatCard, Empty, Pill, Alert, statGrid } from '@/components/ui/kit'
import { ApproveButton } from './approve-button'
import { SwipeRow, type SwipeSpec } from '@/components/ui/swipe'
import { approveBillAction } from '../bills/actions'

export default async function ApprovalsPage() {
  const ctx = await requireContext()
  const mayApprove = can(ctx.role, 'bills.approve', 'approve')

  const bills = await prisma.vendorBill.findMany({
    where: { companyId: ctx.companyId, status: 'DRAFT' },
    include: { vendor: { select: { name: true, pan: true, isForeignSupplier: true } }, project: { select: { name: true } } },
    orderBy: [{ billDate: 'asc' }],
  })

  // docs/93 — rupees: a foreign bill counts as the rupee total it will be booked at
  const total = bills.reduce((a, b) => a.plus((b.grandTotalInr ?? b.grandTotal).toString()), ZERO)
  const today = new Date()
  const overdue = bills.filter((b) => b.dueDate < today)

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals"
        sub="Bills waiting on a decision. Nothing is posted, paid or claimable until approved." />

      <div className={`${statGrid} sm:grid-cols-3`}>
        <StatCard label="Waiting" value={String(bills.length)} foot="draft bills" />
        <StatCard label="Value" value={formatINR(total, { decimals: false })} />
        <StatCard label="Already past due" value={String(overdue.length)}
          tone={overdue.length > 0 ? 'accent' : 'default'} foot={overdue.length > 0 ? 'approve or the payment is late' : undefined} />
      </div>

      {!mayApprove && bills.length > 0 && (
        <Alert tone="info" title="You can see these but not approve them">
          Approval needs the owner or an accountant. The list is here so you know what is waiting.
        </Alert>
      )}

      {bills.length === 0 ? (
        <Card><Empty icon="CheckCircle2" title="Nothing waiting"
          hint="Bills appear here while they are drafts. Approving one posts it to the ledger, books any TDS and makes its input credit claimable." /></Card>
      ) : (
        <div className="space-y-3">
          {bills.map((b) => {
            const noPan = !b.vendor.pan && !b.vendor.isForeignSupplier
            const late = b.dueDate < today
            /**
             * docs/68 §3. This is the owner's mobile tab, so it is the screen the gesture was
             * for. 🔴 A bill with no PAN on file is not offered it: s.206AA forces 20% and
             * Form 16A cannot be issued, so approving is a decision to be read about rather
             * than a thumb movement — the card says so and keeps the button.
             */
            const spec: SwipeSpec | undefined = mayApprove && !noPan ? {
              right: { kind: 'commit', label: 'Approve', legend: 'to approve it', icon: 'Check', tone: 'good',
                done: `Approving ${b.billNumber}`, run: approveBillAction.bind(null, b.id) },
              left: { kind: 'link', label: 'Review', legend: 'to review it first', icon: 'Search', tone: 'info', href: `/bills/${b.id}` },
            } : undefined
            const card = (
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/bills/${b.id}`} className="text-[14px] font-semibold hover:underline">
                        {b.billNumber}
                      </Link>
                      {b.isRcm && <Pill tone="warn">reverse charge</Pill>}
                      {late && <Pill tone="critical">past due</Pill>}
                      {noPan && <Pill tone="critical">no PAN</Pill>}
                    </div>
                    <p className="mt-1 text-[13px]">{b.vendor.name}</p>
                    <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                      {b.billDate.toISOString().slice(0, 10)} · due {b.dueDate.toISOString().slice(0, 10)}
                      {b.project && ` · ${b.project.name}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[15px] font-semibold tabular">{formatINR(b.grandTotal.toString())}</p>
                    {new Decimal(b.tdsAmount.toString()).gt(0) && (
                      <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                        less TDS {formatINR(b.tdsAmount.toString())} u/s {b.tdsSection}
                      </p>
                    )}
                  </div>
                </div>

                {noPan && (
                  <p className="mt-2.5 rounded-lg px-3 py-2 text-[11.5px]"
                    style={{ background: 'var(--surface)', color: 'var(--critical)' }}>
                    No PAN on file — s.206AA forces 20% instead of the section rate, and Form 16A
                    cannot be issued. <Link href="/tax/pan" className="underline">Add it first.</Link>
                  </p>
                )}

                {mayApprove && (
                  <div className="mt-3 flex items-center gap-2">
                    <ApproveButton billId={b.id} number={b.billNumber} />
                    <Link href={`/bills/${b.id}`} className="text-[12.5px] underline"
                      style={{ color: 'var(--text-muted)' }}>Review first</Link>
                  </div>
                )}
              </Card>
            )
            return spec
              ? <div key={b.id}><SwipeRow spec={spec} card>{card}</SwipeRow></div>
              : <div key={b.id}>{card}</div>
          })}
        </div>
      )}
    </div>
  )
}
