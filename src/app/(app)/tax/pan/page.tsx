import { requireContext } from '@/server/context'
import { panRegister } from '@/server/services/tax/pan-register'
import { prisma } from '@/server/db'
import { formatINR } from '@/lib/money'
import { PageHeader, Card, Alert } from '@/components/ui/kit'
import { PanForms } from './forms'

export default async function PanPage() {
  const ctx = await requireContext()
  const reg = await panRegister(ctx)

  // one query for every card on the page, rather than one per row
  const cards = await prisma.attachment.findMany({
    where: {
      companyId: ctx.companyId, kind: 'PAN_CARD', detachedAt: null,
      entityType: { in: ['Employee', 'Vendor'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, entityType: true, entityId: true },
  })
  const cardsBy = new Map<string, { id: string; filename: string }[]>()
  for (const c of cards) {
    const key = `${c.entityType}:${c.entityId}`
    cardsBy.set(key, [...(cardsBy.get(key) ?? []), { id: c.id, filename: c.filename }])
  }

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="PAN register"
        sub="Every person Adpedia deducts tax from. Without a PAN, s.206AA forces 20%." />

      {reg.missing > 0 && (
        <Alert tone="critical" title={`${reg.missing} of ${reg.rows.length} have no PAN on file`}>
          Section 206AA applies <strong>20%</strong> where a PAN is missing — double the 194J rate
          and twenty times the 194C individual rate. The money is not lost, but the payee only
          gets it back by filing a return and waiting for a refund.
          {reg.totalExcessWithheld.gt(0) && (
            <> So far that is <strong>{formatINR(reg.totalExcessWithheld)}</strong> withheld in excess this year.</>
          )}
        </Alert>
      )}

      {reg.duplicated > 0 && (
        <Alert tone="critical" title="The same PAN is on file for more than one person">
          One of them is wrong, or the same person is recorded twice. Either way the 26Q return
          aggregates their payments under one deductee and the thresholds are computed against
          the wrong total.
        </Alert>
      )}

      {reg.undocumented > 0 && (
        <Alert tone="warn" title={`${reg.undocumented} have a PAN on file with no copy of the card`}>
          The rate is already right &mdash; s.206AA turns on whether the payee <em>furnished</em> a PAN, and
          they have. The card is what the company holds to show it asked, and the only way to catch a
          digit typed wrong before TRACES does.
        </Alert>
      )}

      <Alert tone="info" title="PANs are not checked online, by design">
        Nothing here contacts the Income Tax portal. A PAN is recorded as the payee gave it, and the
        evidence behind it is <strong>a copy of the card, uploaded and confirmed by a person</strong>.
        <br />
        What that cannot do is prove the PAN exists: a wrong but well-formed number is reported against
        a stranger, the real payee never sees it in their 26AS, and it surfaces as a short-deduction
        notice on TRACES after the 26Q is filed. Comparing the card against the number is what catches
        it first.
      </Alert>

      <PanForms rows={reg.rows.map((r) => ({
        kind: r.kind, id: r.id, name: r.name, pan: r.pan,
        section: r.section, verified: r.verified,
        effective: r.effectiveRatePct.toFixed(0),
        correct: r.correctRatePct.toFixed(0),
        paid: r.paidThisFy.toFixed(2),
        excess: r.excessWithheld.toFixed(2),
        issues: r.issues,
        chases: r.chases,
        card: {
          kind: r.kind, id: r.id, evidence: r.evidence,
          cards: cardsBy.get(`${r.kind === 'EMPLOYEE' ? 'Employee' : 'Vendor'}:${r.id}`) ?? [],
        },
      }))} />

      <Card className="p-4">
        <p className="text-[14px] font-semibold">Why this matters beyond the rate</p>
        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <li>&bull; <strong>Form 16 / 16A cannot be issued</strong> without a PAN, so the payee has no proof of the deduction.</li>
          <li>&bull; The deduction never reaches their <strong>Form 26AS</strong>, so they cannot claim it.</li>
          <li>&bull; A 26Q filed with missing or invalid PANs attracts a <strong>short-deduction demand</strong> on TRACES.</li>
          <li>&bull; The 4th character decides <strong>194C at 1% or 2%</strong> — it is the only reliable source for that.</li>
        </ul>
      </Card>
    </div>
  )
}
