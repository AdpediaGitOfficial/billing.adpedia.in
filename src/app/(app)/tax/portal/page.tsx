import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { isGstRegistered } from '@/server/services/invoicing/document-type'
import { Card, CardHeader, PageHeader, StatCard, Alert, Pill, statGrid } from '@/components/ui/kit'
import {
  reconcileLedger, reconcileChallans, portalConfidence, listPortalStatements,
} from '@/server/services/tax/portal-reconciliation'
import { ImportStatement } from './import-form'
import { LedgerComparison, ChallanComparison } from './comparison'
import { reconcile2b } from '@/server/services/tax/gstr2b'
import { Itc2b } from './itc'

const KIND_LABEL: Record<string, string> = {
  GST_CASH_LEDGER: 'Cash ledger', GST_CREDIT_LEDGER: 'Credit ledger',
  GST_CHALLANS: 'GST challans', TDS_CHALLANS: 'OLTAS challans', GST_2B: 'GSTR-2B',
}

export default async function PortalPage() {
  const ctx = await requireContext()
  /**
   * 🔴 docs/82 §4 — this page is not `gstOnly`, and must not be: OLTAS challan status is the
   * one statement here that an unregistered entity still has a use for. So the GST half is
   * gated section by section instead. Reconciling an electronic ledger it does not hold would
   * compare its books against zero and call the agreement good.
   */
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId }, select: { gstRegistrationType: true },
  })
  const gst = isGstRegistered(company.gstRegistrationType)

  const [confidence, statements] = await Promise.all([
    portalConfidence(ctx),
    listPortalStatements(ctx),
  ])
  const cash = gst ? await reconcileLedger(ctx, 'GST_CASH_LEDGER') : null
  const credit = gst ? await reconcileLedger(ctx, 'GST_CREDIT_LEDGER') : null
  // 🔴 these write (they persist the confirmation), so they run after the reads
  const tdsChallans = await reconcileChallans(ctx, 'TDS_CHALLANS')
  const gstChallans = gst ? await reconcileChallans(ctx, 'GST_CHALLANS') : null
  const itc = gst ? await reconcile2b(ctx) : null

  const unconfirmed = confidence.tds.unconfirmed + confidence.gst.unconfirmed
  const total = confidence.tds.total + confidence.gst.total

  return (
    <div className="space-y-5">
      <PageHeader
        title="The portal"
        sub="What the department holds, against what this system says it holds"
      />

      <Alert tone="info" title="Nothing here talks to the portal">
        This system has no portal credentials and will not get any. The department&apos;s word arrives
        the way the CA&apos;s word arrives — as a statement somebody downloaded and brought here — and it
        is kept with the date it was as at, because &ldquo;the portal agreed on 30 September&rdquo; is the only
        answer to a notice that arrives in March.
      </Alert>

      {confidence.cinUnverified.length > 0 && (
        <Alert tone="critical" title={confidence.cinUnverified.length === 1
            ? 'A challan carries a CIN that its own references do not make'
            : `${confidence.cinUnverified.length} challans carry a CIN that their own references do not make`}>
          A CIN is the BSR code, then the date of tender as DDMMYYYY, then the 5-digit serial.
          {confidence.cinUnverified.slice(0, 4).map((c) => (
            <span key={c.id} className="mt-1 block font-mono text-[11.5px]">
              {c.cin} on record · {c.fromRefs} from the BSR code, {c.depositedOn.toISOString().slice(0, 10)} and the serial
            </span>
          ))}
          <span className="mt-1 block">
            Check each against the counterfoil before the return goes out — TRACES matches on the CIN and
            rejects the challan, not the file, so every deductee on it loses their credit.
          </span>
        </Alert>
      )}

      <div className={`${statGrid} sm:grid-cols-2 lg:grid-cols-4`}>
        <StatCard label="Challans never checked" value={String(unconfirmed)} icon="ShieldQuestion"
          tone={unconfirmed > 0 ? 'accent' : 'default'}
          foot={total === 0 ? 'No challans recorded yet'
            : `of ${total} · a challan records itself as paid and then looks exactly like one somebody verified`} />
        <StatCard label="TDS challans confirmed" value={`${confidence.tds.confirmed} / ${confidence.tds.total}`} icon="ScrollText"
          foot="Against OLTAS — the CIN here is constructed, not issued" />
        {gst && (
          <StatCard label="GST challans confirmed" value={`${confidence.gst.confirmed} / ${confidence.gst.total}`} icon="Percent"
            foot="Against the portal's own challan history" />
        )}
        <StatCard label="Statements on file" value={String(statements.length)} icon="FileStack"
          foot={statements.length === 0 ? 'Nothing imported yet' : `Latest ${statements[0].importedAt.toISOString().slice(0, 10)}`} />
      </div>

      <Card>
        <CardHeader title="Import a statement" sub="Paste what the portal shows — the date matters more than the format" />
        <div className="mt-4"><ImportStatement gstRegistered={gst} /></div>
      </Card>

      {cash && <LedgerComparison r={cash} />}
      {credit && <LedgerComparison r={credit} />}
      {/* docs/62 — the credit ledger says how much is wrong; this says whose */}
      {itc && <Itc2b r={itc} />}
      <ChallanComparison r={tdsChallans} title="TDS challans against OLTAS" />
      {gstChallans && <ChallanComparison r={gstChallans} title="GST challans against the portal" />}

      {statements.length > 0 && (
        <Card flush className="overflow-hidden">
          <CardHeader title="What the portal has said, and when" className="p-5 pb-3"
            sub="Kept because a comparison nobody can date proves nothing" />
          <div className="px-5 pb-4">
            <table className="w-full text-[12.5px]">
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id} className="border-t align-top" style={{ borderColor: 'var(--rule)' }}>
                    <td className="py-2 font-medium">{KIND_LABEL[s.kind] ?? s.kind}</td>
                    <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>
                      as at {s.asOn.toISOString().slice(0, 10)}
                    </td>
                    <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                      {s.filename ?? `${s.lines} row${s.lines === 1 ? '' : 's'}`}
                    </td>
                    <td className="py-2 text-right">
                      {s.verdict
                        ? <span style={{ color: 'var(--text-muted)' }}>{s.verdict}</span>
                        : <Pill tone="neutral">imported</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
