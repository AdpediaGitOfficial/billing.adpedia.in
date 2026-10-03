import { Card, CardHeader, Pill, Alert } from '@/components/ui/kit'
import { formatINR } from '@/lib/money'
import type { Recon2b } from '@/server/services/tax/gstr2b'

/**
 * GSTR-2B against the purchase register — docs/62.
 *
 * 🔴 The order is deliberate. What the books claim and the portal does not hold comes first,
 * because that is the money: under s.16(2)(aa) it is credit that may not be taken at all.
 * What the portal holds and the books do not is second — unclaimed credit is a cost too, but
 * it is not a liability with interest running on it.
 */
export function Itc2b({ r }: { r: Recon2b }) {
  const problems = r.notInPortal.length + r.blocked.length + r.taxDiffers.length + r.notInBooks.length

  return (
    <Card flush className="overflow-hidden">
      <CardHeader
        title="Input credit, invoice by invoice" className="p-5 pb-3"
        sub={r.asOn
          ? `Against GSTR-2B as at ${r.asOn.toISOString().slice(0, 10)} · ${r.verdict}`
          : 'Nothing imported yet — the credit ledger comparison above can say how much is wrong, not whose'}
        action={<Pill tone={!r.asOn ? 'neutral' : problems === 0 ? 'good' : 'critical'} dot>
          {!r.asOn ? 'not checked' : problems === 0 ? 'all agree' : `${problems} to look at`}
        </Pill>} />

      {r.asOn && r.totals.creditAtRisk.gt(0) && (
        <div className="px-5 pb-3">
          <Alert tone="critical" title={`${formatINR(r.totals.creditAtRisk)} of input credit is not available`}>
            Under s.16(2)(aa) credit may not be taken unless the supplier has declared the invoice and it
            appears in this statement. Where a GSTR-3B has already claimed it, it must be reversed with
            interest at 18% under s.50(3) read with rule 88B(3).
          </Alert>
        </div>
      )}

      <div className="space-y-2 px-5 pb-4 text-[12.5px]">
        {r.notInPortal.map((x) => (
          <div key={x.billId} className="rounded-lg px-3 py-2" style={{ background: 'var(--critical-soft)' }}>
            <p className="font-semibold" style={{ color: 'var(--critical)' }}>
              {x.vendorName} · {x.billNumber} · {formatINR(x.tax)}
            </p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--critical)', opacity: 0.9 }}>{x.action}</p>
          </div>
        ))}

        {r.blocked.map((x) => (
          <div key={x.billId} className="rounded-lg px-3 py-2" style={{ background: 'var(--critical-soft)' }}>
            <p className="font-semibold" style={{ color: 'var(--critical)' }}>
              {x.vendorName} · {x.billNumber} · {formatINR(x.ourTax)}
            </p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--critical)', opacity: 0.9 }}>
              The portal has this invoice and says the credit is not available — {x.blockedByPortal}. Our books claim it.
            </p>
          </div>
        ))}

        {r.taxDiffers.map((x) => (
          <div key={x.billId} className="rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)' }}>
            <p className="font-semibold" style={{ color: 'var(--warn)' }}>{x.vendorName} · {x.billNumber}</p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--warn)', opacity: 0.9 }}>
              We claim {formatINR(x.ourTax)}; the portal shows {formatINR(x.portalTax)}. Only the lower figure is
              available — check the invoice against what the supplier filed.
            </p>
          </div>
        ))}

        {r.notInBooks.map((x) => (
          <div key={x.id} className="rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)' }}>
            <p className="font-semibold" style={{ color: 'var(--warn)' }}>
              {x.supplier} · {x.docNumber} · {formatINR(x.tax)}
            </p>
            <p className="mt-0.5 leading-relaxed" style={{ color: 'var(--warn)', opacity: 0.9 }}>{x.action}</p>
          </div>
        ))}

        {r.matched.length > 0 && (
          <table className="w-full">
            <tbody>
              {r.matched.map((m) => (
                <tr key={m.billId} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                  <td className="py-2 font-medium">{m.vendorName}</td>
                  <td className="py-2 tabular" style={{ color: 'var(--text-muted)' }}>{m.billNumber}</td>
                  <td className="py-2 text-right tabular">{formatINR(m.ourTax)}</td>
                  <td className="py-2 pl-3 text-right"><Pill tone="good" dot>matched on {m.tier}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!r.asOn && (
          <p style={{ color: 'var(--text-muted)' }}>
            Download GSTR-2B from Returns → GSTR-2B and paste the JSON above. It carries the portal&rsquo;s own
            verdict on each invoice, which a hand-made sheet does not.
          </p>
        )}
      </div>
    </Card>
  )
}
