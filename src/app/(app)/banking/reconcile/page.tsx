import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { reconciliationQueue, bankReconciliationStatement } from '@/server/services/banking/reconcile'
import { formatINR, ZERO } from '@/lib/money'
import { Card, CardHeader, PageHeader, StatCard, Button, Empty, Alert } from '@/components/ui/kit'
import { ReconcileQueue } from './queue'
import { MatchedLines } from './matched'

export default async function ReconcilePage() {
  const ctx = await requireContext()
  const bank = await prisma.companyBankAccount.findFirst({ where: { companyId: ctx.companyId, isDefault: true } })
  if (!bank) return <Card><Empty icon="Landmark" title="No bank account" hint="Add one in Settings before importing a statement." /></Card>

  const [queue, brs, matchedCount, matched] = await Promise.all([
    reconciliationQueue(ctx, bank.id),
    bankReconciliationStatement(ctx, bank.id),
    prisma.bankTransaction.count({ where: { companyId: ctx.companyId, bankAccountId: bank.id, status: 'MATCHED' } }),
    // docs/49 — the matched lines themselves, so a wrong match can be found and undone
    prisma.bankTransaction.findMany({
      where: {
        companyId: ctx.companyId, bankAccountId: bank.id,
        status: { in: ['MATCHED', 'EXCLUDED'] },
      },
      include: {
        receipt: { select: { number: true } },
        billPayment: { select: { reference: true, bill: { select: { billNumber: true, vendor: { select: { name: true } } } } } },
      },
      orderBy: { valueDate: 'desc' },
      take: 25,
    }),
  ])

  const total = queue.length + matchedCount
  const remaining = queue.reduce((a, q) => a.plus(q.txn.amount), ZERO)
  const confident = queue.filter((q) => (q.suggestions[0]?.confidence ?? 0) >= 85).length

  return (
    <div className="space-y-5">
      <PageHeader title="Reconcile" sub={`${bank.label} ····${bank.accountNo.slice(-4)}`}
        action={<Link href="/banking/import"><Button variant="ghost" icon="Upload">Import statement</Button></Link>} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="To match" value={String(queue.length)} icon="ListChecks"
          foot={total > 0 ? `${matchedCount} of ${total} done` : 'Import a statement to start'} tone={queue.length ? 'accent' : 'default'} />
        <StatCard label="Confident suggestions" value={String(confident)} icon="Sparkles"
          foot={confident ? 'Accept in one pass' : 'Nothing above 85%'} />
        <StatCard label="Value unmatched" value={formatINR(remaining, { decimals: false })} icon="Wallet" />
        <StatCard label="Books vs statement" value={brs.agrees ? 'Agrees' : formatINR(brs.difference ?? ZERO, { decimals: false })} icon="Scale"
          foot={brs.statementBalance ? `statement ${formatINR(brs.statementBalance, { decimals: false })}` : 'no statement imported'} />
      </div>

      {!brs.agrees && brs.statementBalance && (
        <Alert tone="warn" title="Books and statement do not yet agree">
          Book balance {formatINR(brs.bookBalance)} plus {formatINR(brs.unmatchedCredits)} of unbooked
          credits less {formatINR(brs.unmatchedDebits)} of unbooked debits comes to{' '}
          {formatINR(brs.reconciled)}, against a statement closing balance of {formatINR(brs.statementBalance)}.
          They agree once the {brs.unmatchedCount} remaining line{brs.unmatchedCount === 1 ? '' : 's'} are matched.
        </Alert>
      )}

      <MatchedLines
        total={matchedCount}
        rows={matched.map((m) => ({
          id: m.id,
          date: m.valueDate.toISOString().slice(0, 10),
          narration: m.rawNarration,
          amount: m.amount.toFixed(2),
          direction: m.direction,
          matchedTo: m.receipt
            ? `Receipt ${m.receipt.number}`
            : m.billPayment
              ? `Payment to ${m.billPayment.bill.vendor.name} against ${m.billPayment.bill.billNumber}`
              : m.journalEntryId
                ? 'Posted as a journal entry'
                : 'Excluded from reconciliation',
          reason: m.matchReason,
          excluded: m.status === 'EXCLUDED',
        }))} />

      {queue.length === 0 ? (
        <Card>
          <Empty icon="CheckCircle2" title="Nothing left to match"
            hint={matchedCount > 0 ? `All ${matchedCount} imported lines have been reconciled. The books agree with the bank.` : 'Import a statement to begin.'}
            action={<Link href="/banking/import"><Button>Import a statement</Button></Link>} />
        </Card>
      ) : (
        <Card flush>
          <CardHeader title="Queue" className="p-5 pb-4"
            sub="Each suggestion says why it was offered — accept, split or skip." />
          <ReconcileQueue
            rows={queue.map((q) => ({
              id: q.txn.id,
              amount: q.txn.amount.toFixed(2),
              direction: q.txn.direction,
              valueDate: q.txn.valueDate.toISOString().slice(0, 10),
              narration: q.txn.rawNarration,
              counterparty: q.txn.counterparty,
              suggestions: q.suggestions.map((s) => ({
                tier: s.tier, tierName: s.tierName, confidence: s.confidence, reason: s.reason,
                kind: s.suggestion.kind,
              })),
            }))}
          />
        </Card>
      )}
    </div>
  )
}
