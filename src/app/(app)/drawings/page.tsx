import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { formatINR } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Alert, Empty, Pill, statGrid } from '@/components/ui/kit'
import { requireDrawings } from '@/components/shell/not-registered'
import { currentFinancialYear } from '@/server/services/accounting/period'
import { drawingsSummary, DRAWING_PURPOSES, purposeLabel } from '@/server/services/equity/drawings'
import { MovementForm } from './form'

export default async function DrawingsPage() {
  const ctx = await requireContext()
  // 🔴 docs/82 §4 — hidden from the rail is not refused, and the service refuses too
  const notAllowed = await requireDrawings(ctx.companyId, 'Drawings')
  if (notAllowed) return notAllowed

  const [company, fy] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId }, select: { constitution: true },
    }),
    currentFinancialYear(ctx.companyId),
  ])
  const label = company.constitution === 'PROPRIETORSHIP' ? 'Drawings' : "Partners' drawings"

  if (!fy) {
    return (
      <div className="max-w-3xl space-y-5">
        <PageHeader title={label} />
        <Alert tone="warn" title="No open financial year">
          A drawing is posted into a financial year like everything else. Open one first.
        </Alert>
      </div>
    )
  }

  const s = await drawingsSummary(ctx, { from: fy.startsOn, to: fy.endsOn })

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title={label}
        sub={`Money between the owner and the business, FY ${fy.label}. Equity — none of it touches the profit.`} />

      {/*
        🔴 The sentence the whole module exists for. Somebody recording groceries against an
        expense category instead would understate the profit they declare by the whole amount,
        and s.37(1) is the provision that would be cited when it was noticed.
      */}
      <Alert tone="info" title="Recorded in full, deducted nowhere">
        A proprietor and the business are one person for income tax, so rent, groceries and
        medical bills belong on this screen rather than in expenses: the money trail stays
        complete and the declared profit does not move. Some of it <em>is</em> deductible —
        in the <strong>personal</strong> return, not here. Rent against the HRA in a salary under
        s.10(13A), insurance under s.80D, 80C investments. That is what the purpose is kept for.
      </Alert>

      <div className={`${statGrid} sm:grid-cols-2 lg:grid-cols-4`}>
        <StatCard label="Taken out" value={formatINR(s.drawn, { decimals: false })} icon="ArrowUpRight"
          foot={`FY ${fy.label} to date`} />
        <StatCard label="Put in" value={formatINR(s.introduced, { decimals: false })} icon="ArrowDownLeft"
          foot="capital introduced" />
        <StatCard label="Net withdrawn" value={formatINR(s.net, { decimals: false })} icon="Banknote"
          tone={s.net.gt(0) ? 'accent' : 'default'} />
        {/* 🔴 negative is information, not an error — see drawingsSummary */}
        <StatCard label="Owner's funds" value={formatINR(s.ownerFunds, { decimals: false })} icon="Scale"
          tone={s.ownerFunds.lt(0) ? 'accent' : 'default'}
          foot={s.ownerFunds.lt(0)
            ? 'negative — more has been taken out than the business has earned, so creditors are funding it'
            : 'capital and retained profit, after drawings'} />
      </div>

      <Card>
        <CardHeader title="Record a movement" sub="Out to the owner, or in from them" />
        <div className="mt-4">
          <MovementForm purposes={DRAWING_PURPOSES.map((p) => ({ ...p }))} drawingsLabel={label} />
        </div>
      </Card>

      {s.byPurpose.length > 0 && (
        <Card flush className="overflow-hidden">
          <CardHeader title="What it went on" className="p-5 pb-3"
            sub="Kept so the personal return can be prepared from a complete record" />
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {s.byPurpose.map((row) => (
              <div key={row.purpose} className="flex items-center justify-between gap-3 px-5 py-3">
                <p className="text-[13px] font-medium">{row.label}</p>
                <p className="text-[13px] font-semibold tabular">{formatINR(row.total)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card flush className="overflow-hidden">
        <CardHeader title="Every movement" className="p-5 pb-3"
          sub={`${s.movements.length} recorded · a wrong drawing is corrected by a capital entry, never deleted`} />
        {s.movements.length === 0 ? (
          <Empty icon="Banknote" title="Nothing recorded yet"
            hint="Every debit on the bank statement that was personal belongs here — that is what makes the statement reconcile." />
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--rule)' }}>
            {s.movements.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{m.narration}</p>
                  <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {m.date.toISOString().slice(0, 10)}
                    {m.kind === 'DRAWING' && ` · ${purposeLabel(m.purpose)}`}
                    {` · ${m.source === 'CASH' ? 'cash' : 'bank'}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Pill tone={m.kind === 'DRAWING' ? 'neutral' : 'good'}>
                    {m.kind === 'DRAWING' ? 'out' : 'in'}
                  </Pill>
                  <p className="text-[13.5px] font-semibold tabular">{formatINR(m.amount.toString())}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
