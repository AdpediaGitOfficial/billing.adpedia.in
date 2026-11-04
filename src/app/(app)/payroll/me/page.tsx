import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { Decimal, formatINR, ZERO } from '@/lib/money'
import { Card, PageHeader, StatCard, Empty, Pill, Alert, statGrid } from '@/components/ui/kit'
import { employeeForUser } from '@/server/services/payroll/access'

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export default async function MyPayslipsPage() {
  const ctx = await requireContext()

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId }, select: { email: true, name: true },
  })

  // 🔴 docs/57 — one copy of the rule, shared with the document route. Employee is matched
  // by email within this company; there is no userId on Employee, and without the company
  // filter a shared address would surface another entity's payslips. The route had to make
  // the same decision, and two copies of a rule like this drift until one of them is wrong.
  const employee = await employeeForUser(ctx)

  if (!employee) {
    return (
      <div className="max-w-2xl space-y-5">
        <PageHeader title="My payslips" />
        <Card><Empty icon="IdCard" title="No employee record matches your sign-in"
          hint={`Payslips are matched to the employee whose email is ${user.email}. Ask whoever runs payroll to set that address on your employee record.`} /></Card>
      </div>
    )
  }

  const payslips = await prisma.payslip.findMany({
    where: { employeeId: employee.id, payrollRun: { companyId: ctx.companyId, status: { not: 'DRAFT' } } },
    include: { payrollRun: { select: { month: true, year: true, status: true } } },
    orderBy: [{ payrollRun: { year: 'desc' } }, { payrollRun: { month: 'desc' } }],
  })

  // 🔴 docs/57 — a CANCELLED run keeps its payslips (docs/50), and they were being added up
  // here. The totals told the employee they had been paid money that was reversed out of the
  // books, and that tax had been deducted which no longer exists in any return. The slip
  // itself still shows, marked cancelled, because they may well have been handed it.
  const counted = payslips.filter((p) => p.payrollRun.status !== 'CANCELLED')
  const ytdGross = counted.reduce((a, p) => a.plus(p.gross.toString()), ZERO)
  const ytdTds = counted.reduce((a, p) => a.plus(p.tds.toString()), ZERO)
  const ytdNet = counted.reduce((a, p) => a.plus(p.net.toString()), ZERO)

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="My payslips"
        sub={`${employee.name} · ${employee.employeeCode}${employee.designation ? ` · ${employee.designation}` : ''}`} />

      {!employee.pan && (
        <Alert tone="warn" title="No PAN on your record">
          Without a PAN the tax deducted from your salary cannot be reported against you, so it
          will not appear in your Form 26AS and <strong>Form 16 cannot be issued</strong>. Give it
          to whoever runs payroll.
        </Alert>
      )}

      {payslips.length === 0 ? (
        <Card><Empty icon="IdCard" title="No payslips yet"
          hint="A payslip appears once the monthly payroll run is approved. Drafts are not shown — they can still change." /></Card>
      ) : (
        <>
          <div className={`${statGrid} sm:grid-cols-3`}>
            <StatCard label="Gross to date" value={formatINR(ytdGross, { decimals: false })} foot={`${counted.length} month${counted.length === 1 ? '' : 's'}`} />
            <StatCard label="Tax deducted" value={formatINR(ytdTds, { decimals: false })} foot="u/s 192" />
            <StatCard label="Net received" value={formatINR(ytdNet, { decimals: false })} tone="accent" />
          </div>

          <div className="space-y-3">
            {payslips.map((p) => (
              <Card key={p.id} flush className="overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-2.5"
                  style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                  <span className="text-[13px] font-semibold">
                    {MONTHS[p.payrollRun.month]} {p.payrollRun.year}
                  </span>
                  <span className="flex items-center gap-3">
                    <a href={`/api/payslips/${p.id}/document`} target="_blank" rel="noreferrer"
                      className="text-[11.5px] underline" style={{ color: 'var(--accent)' }}>download</a>
                    <Pill tone={p.payrollRun.status === 'PAID' ? 'good' : p.payrollRun.status === 'CANCELLED' ? 'critical' : 'accent'}>
                      {p.payrollRun.status.toLowerCase()}
                    </Pill>
                  </span>
                </div>
                <table className="w-full text-[13px]">
                  <tbody>
                    <Row k="Gross" v={formatINR(p.gross.toString())} />
                    {new Decimal(p.tds.toString()).gt(0) && <Row k="Less: TDS u/s 192" v={`(${formatINR(p.tds.toString())})`} />}
                    {new Decimal(p.professionTax.toString()).gt(0) && (
                      <Row k="Less: Profession tax (Kerala)" v={`(${formatINR(p.professionTax.toString())})`} />
                    )}
                    {new Decimal(p.deductions.toString()).gt(0) && (
                      <Row k="Less: Other deductions" v={`(${formatINR(p.deductions.toString())})`} />
                    )}
                    <Row k="Net paid" v={formatINR(p.net.toString())} strong />
                  </tbody>
                </table>
              </Card>
            ))}
          </div>

          <Card className="p-4">
            <p className="eyebrow">About the tax deducted</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Salary TDS under s.192 is not a flat rate. It is your estimated annual liability
              spread across the remaining months of the year, so the monthly figure changes when
              the estimate does. Profession tax is a Kerala levy deducted twice a year, in
              September and March, and is capped at ₹2,500 for the year.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'border-t-2' : 'border-t'} style={{ borderColor: 'var(--rule)' }}>
      <td className={`px-4 py-2.5 ${strong ? 'font-semibold' : ''}`}
        style={strong ? undefined : { color: 'var(--text-muted)' }}>{k}</td>
      <td className={`px-4 py-2.5 text-right tabular ${strong ? 'font-semibold' : ''}`}>{v}</td>
    </tr>
  )
}
