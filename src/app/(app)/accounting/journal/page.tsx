import Link from 'next/link'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { resolvePeriod } from '@/server/services/reports/period'
import { formatINR, Decimal, ZERO } from '@/lib/money'
import { Card, PageHeader, Empty, Pill } from '@/components/ui/kit'
import { ExportButton } from '@/components/reports/export-button'
import { PeriodPicker } from '../../reports/period-picker'

const PAGE = 50

export default async function JournalPage({ searchParams }: {
  searchParams: Promise<{ fy?: string; page?: string }>
}) {
  const { fy, page } = await searchParams
  const ctx = await requireContext()
  const period = await resolvePeriod(ctx.companyId, fy)
  const pageNo = Math.max(1, Number(page ?? '1') || 1)

  const where = { companyId: ctx.companyId, date: { gte: period.from, lte: period.to } }
  const [total, entries] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({
      where,
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      orderBy: [{ date: 'desc' }, { entryNo: 'desc' }],
      skip: (pageNo - 1) * PAGE,
      take: PAGE,
    }),
  ])
  const pages = Math.ceil(total / PAGE)

  return (
    <div className="space-y-5">
      <PageHeader title="Journal" sub={`${total} entries in ${period.label} · the complete record, newest first`}
        action={
          <div className="flex items-center gap-2">
            {/* 🔴 the export is the WHOLE period, not this page — docs/58. Paging is for
                reading; a journal missing its last page is not a journal. */}
            <ExportButton report="journal" fy={period.fyId} label="Export journal" />
            <PeriodPicker options={period.options} value={period.fyId} />
          </div>
        } />

      {entries.length === 0 ? (
        <Card><Empty icon="BookOpen" title={`No entries in ${period.label}`}
          hint="Every invoice, bill, receipt and payroll run posts here automatically. Nothing here is sample data." /></Card>
      ) : (
        <>
          <div className="space-y-3">
            {entries.map((e) => {
              const dr = e.lines.reduce((a, l) => a.plus(l.debit.toString()), ZERO)
              const cr = e.lines.reduce((a, l) => a.plus(l.credit.toString()), ZERO)
              const balanced = dr.equals(cr)
              return (
                <Card key={e.id} flush className="overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5"
                    style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                    <div className="min-w-0">
                      <span className="tabular text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        #{e.entryNo} · {e.date.toISOString().slice(0, 10)}
                      </span>
                      <span className="ml-2.5 text-[13px] font-medium">{e.narration}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone="neutral">{e.sourceType.replace('_', ' ').toLowerCase()}</Pill>
                      {!balanced && <Pill tone="critical">unbalanced</Pill>}
                    </div>
                  </div>
                  <table className="w-full text-[12.5px]">
                    <tbody>
                      {e.lines.map((l) => (
                        <tr key={l.id} className="border-t" style={{ borderColor: 'var(--rule)' }}>
                          <td className="px-4 py-2">
                            <Link href={`/accounting/accounts/${l.account.code}?fy=${period.fyId}`} className="hover:underline">
                              <span className="tabular" style={{ color: 'var(--text-muted)' }}>{l.account.code}</span>
                              <span className="ml-2.5">{l.account.name}</span>
                            </Link>
                            {l.narration && (
                              <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>{l.narration}</span>
                            )}
                          </td>
                          <td className="w-[18%] px-3 py-2 text-right tabular">
                            {new Decimal(l.debit.toString()).isZero() ? '' : formatINR(l.debit.toString())}
                          </td>
                          <td className="w-[18%] px-4 py-2 text-right tabular">
                            {new Decimal(l.credit.toString()).isZero() ? '' : formatINR(l.credit.toString())}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t-2" style={{ borderColor: 'var(--rule)' }}>
                        <td className="px-4 py-2 font-medium">Total</td>
                        <td className="px-3 py-2 text-right font-semibold tabular">{formatINR(dr)}</td>
                        <td className="px-4 py-2 text-right font-semibold tabular">{formatINR(cr)}</td>
                      </tr>
                    </tbody>
                  </table>
                </Card>
              )
            })}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between text-[13px]">
              <span style={{ color: 'var(--text-muted)' }}>Page {pageNo} of {pages}</span>
              <div className="flex gap-2">
                {pageNo > 1 && (
                  <Link href={`/accounting/journal?fy=${period.fyId}&page=${pageNo - 1}`}
                    className="rounded-lg border px-3 py-1.5 font-medium" style={{ borderColor: 'var(--rule)' }}>Previous</Link>
                )}
                {pageNo < pages && (
                  <Link href={`/accounting/journal?fy=${period.fyId}&page=${pageNo + 1}`}
                    className="rounded-lg border px-3 py-1.5 font-medium" style={{ borderColor: 'var(--rule)' }}>Next</Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
