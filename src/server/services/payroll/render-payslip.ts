import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, ZERO, formatINR, amountInWords } from '@/lib/money'
import { AppError, NotFound } from '@/server/errors'

const TEMPLATE = join(process.cwd(), 'templates', 'payslip', 'payslip.html')
const BRAND_DIR = join(process.cwd(), 'public', 'brand')

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function addressHtml(a: unknown): string {
  const o = (a ?? {}) as Record<string, string>
  return [o.line1, o.line2, [o.city, o.state, o.pincode].filter(Boolean).join(', '), o.country]
    .filter(Boolean).map(esc).join('<br>')
}

interface StoredComponent { code?: string; name: string; type: 'EARNING' | 'DEDUCTION'; amount: string }

/**
 * 🔴 The account number is shown as its last four digits and nothing else.
 *
 * A payslip is forwarded — to a landlord, to a bank, to a visa desk — far more often than
 * any other document this system produces. The employee needs to recognise which account it
 * went to; nobody downstream needs the number itself.
 */
function bankLine(details: unknown): string {
  const b = (details ?? {}) as Record<string, string>
  const acct = (b.accountNo ?? b.accountNumber ?? '').toString().replace(/\s/g, '')
  const parts: string[] = []
  if (b.bankName) parts.push(esc(b.bankName))
  if (acct) parts.push(`A/c &hellip;${esc(acct.slice(-4))}`)
  if (b.ifsc) parts.push(esc(b.ifsc))
  return parts.length > 0
    ? `<span class="lbl">Paid to</span> <b>${parts.join(' &middot; ')}</b>`
    : '<span class="lbl">Paid to</span> <b>&mdash;</b> <span class="lbl">no bank account on the employee record</span>'
}

/**
 * The payslip as a document — docs/57.
 *
 * 🔴 The explanations are read from the SNAPSHOT taken when the run was approved, never
 * recomputed. The s.192 figure is an estimate of the year's tax spread over the months that
 * are left, so the reason October's deduction was ₹4,000 stops being true in November —
 * reprint the slip in March and a live recomputation would explain a deduction that was made
 * in October with arithmetic that did not exist then.
 */
export async function renderPayslipHtml(companyId: string, payslipId: string): Promise<string> {
  const slip = await prisma.payslip.findFirst({
    where: { id: payslipId, payrollRun: { companyId } },
    include: {
      employee: true,
      payrollRun: { select: { id: true, month: true, year: true, status: true, cancelReason: true, financialYearId: true } },
    },
  })
  if (!slip) throw new NotFound('Payslip not found')

  // 🔴 A draft run's figures still move. Issuing a slip from one hands the employee a number
  // that will not be the number they are paid, and they keep the paper.
  if (slip.payrollRun.status === 'DRAFT') {
    throw new AppError('That payroll run is still a draft — approve it before issuing payslips')
  }

  const co = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const run = slip.payrollRun
  const emp = slip.employee

  const money = (v: Decimal.Value) => formatINR(v, { symbol: false })
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

  const from = new Date(Date.UTC(run.year, run.month - 1, 1))
  const to = new Date(Date.UTC(run.year, run.month, 0))

  const stored = (slip.components ?? {}) as { components?: StoredComponent[] }
  const components: StoredComponent[] = Array.isArray(stored.components) ? stored.components : []

  const gross = new Decimal(slip.gross.toString())
  const tds = new Decimal(slip.tds.toString())
  const pt = new Decimal(slip.professionTax.toString())
  const other = new Decimal(slip.deductions.toString())
  const net = new Decimal(slip.net.toString())

  // ── earnings ──
  // 🔴 A structure may carry no itemised components at all — the run then falls back to
  // `grossMonthly`, and the same fallback has to happen here or the slip prints an empty
  // earnings table above a gross total, which reads as money appearing from nowhere.
  const earningRows = components.filter((c) => c.type === 'EARNING')
  const earnings = earningRows.length > 0
    ? earningRows.map((c) => ({ name: c.name, amount: new Decimal(c.amount) }))
    : [{ name: 'Salary for the month', amount: gross }]

  // ── deductions, each named with what it is made under ──
  const deductions: { name: string; sub?: string; amount: Decimal }[] = []
  for (const c of components.filter((c) => c.type === 'DEDUCTION')) {
    deductions.push({ name: c.name, amount: new Decimal(c.amount) })
  }
  // 🔴 `deductions` on the payslip is the TOTAL of the non-statutory deductions, and the
  // itemisation lives in the components JSON. Where the two disagree — a structure saved
  // without its components, an older row — the difference is shown rather than dropped,
  // because a payslip whose items do not add up to its net is the one thing it must never be.
  const itemised = deductions.reduce((a, d) => a.plus(d.amount), ZERO as Decimal)
  if (!itemised.equals(other)) {
    deductions.push({ name: 'Other deductions', amount: other.minus(itemised) })
  }
  if (pt.gt(0)) {
    deductions.push({
      name: 'Profession tax',
      sub: slip.professionTaxNote ?? 'Kerala &mdash; half-yearly levy, Article 276(2)',
      amount: pt,
    })
  }
  if (tds.gt(0)) {
    deductions.push({
      name: 'Income tax deducted at source',
      sub: slip.tdsNote ?? 'Section 192',
      amount: tds,
    })
  }
  const deductionTotal = deductions.reduce((a, d) => a.plus(d.amount), ZERO as Decimal)

  const row = (name: string, amount: Decimal, sub?: string) =>
    `<tr><td>${esc(name)}${sub ? `<span class="sub">${sub}</span>` : ''}</td>` +
    `<td class="num">${money(amount.toFixed(2))}</td></tr>`

  const earningsHtml = earnings.map((e) => row(e.name, e.amount)).join('\n        ')
  const deductionsHtml = deductions.length > 0
    ? deductions.map((d) => row(d.name, d.amount, d.sub)).join('\n        ')
    : '<tr><td>Nothing was deducted this month</td><td class="num">0.00</td></tr>'

  // ── year to date ──
  // 🔴 Cancelled runs are excluded. Their payslips survive (docs/50) and counting them would
  // tell the employee they had been paid money that was reversed out of the books.
  const ytdSlips = await prisma.payslip.findMany({
    where: {
      employeeId: emp.id,
      payrollRun: { companyId, financialYearId: run.financialYearId, status: { in: ['APPROVED', 'PAID'] } },
    },
    select: { gross: true, tds: true, professionTax: true, net: true },
  })
  const ytd = {
    gross: ytdSlips.reduce((a, s) => a.plus(s.gross.toString()), ZERO as Decimal),
    tds: ytdSlips.reduce((a, s) => a.plus(s.tds.toString()), ZERO as Decimal),
    pt: ytdSlips.reduce((a, s) => a.plus(s.professionTax.toString()), ZERO as Decimal),
    net: ytdSlips.reduce((a, s) => a.plus(s.net.toString()), ZERO as Decimal),
    months: ytdSlips.length,
  }
  const ytdHtml = [
    ['Gross', ytd.gross], ['Tax deducted', ytd.tds],
    ...(ytd.pt.gt(0) ? [['Profession tax', ytd.pt] as const] : []),
    ['Net paid', ytd.net],
  ].map(([k, v]) => `<tr><td class="k">${k}</td><td class="num">${money((v as Decimal).toFixed(2))}</td></tr>`)
    .join('\n          ')

  const cancelled = run.status === 'CANCELLED'
  // 🔴 Found by looking at one: the slip promised the employee that the tax deducted would
  // appear in their Form 26AS — on a document for someone with no PAN, where it cannot.
  // s.206AA makes the PAN the thing the deduction is reported against; without it the money
  // is paid to the department and credited to nobody.
  const panMissing = !emp.pan && tds.gt(0)
  const statusLabel = cancelled ? 'Cancelled — void' : run.status === 'PAID' ? 'Paid' : 'Approved, payment pending'

  const tdsExplain = tds.gt(0)
    ? '<b>Income tax (s.192)</b> is not a tax on this month alone. Your employer estimates the tax on ' +
      'your pay for the whole financial year and spreads it over the months that remain, so the monthly ' +
      'figure moves whenever that estimate does. ' +
      (slip.tdsNote ? `This month: ${esc(slip.tdsNote)}.` : '')
    : '<b>No income tax was deducted this month.</b> Under s.192 tax is deducted only once your ' +
      'estimated income for the year exceeds the exemption limit, so nil months early in the year are normal.'

  const ptExplain = '<b>Profession tax</b> is a Kerala levy charged on half-yearly earnings and deducted ' +
    'twice a year, in September and March. Ten payslips in the year show nothing against it &mdash; that is ' +
    'correct, not an omission &mdash; and the total cannot exceed &#8377;2,500 in a year, which Article 276(2) ' +
    'of the Constitution caps for every state.'

  const otherExplain = ytd.months > 0
    ? `This is month ${ytd.months} of the financial year on record for you. The figures on the right are the ` +
      'totals so far, and they are what your Form 16 for the year will be built from.'
    : ''

  const SUBS: [RegExp, string][] = [
    [/class="sheet st-paid"/,
      `class="sheet ${cancelled ? 'st-cancelled' : run.status === 'PAID' ? 'st-paid' : 'st-approved'}${panMissing ? ' no-pan' : ''}"`],
    [/(<div class="period" data-bind="run\.periodTitle">)[^<]*/, `$1${MONTHS[run.month - 1]} ${run.year}`],
    [/(<div class="copy-mark" data-bind="run\.statusLabel">)[^<]*/, `$1${esc(statusLabel)}`],
    [/(<div class="void" data-bind="run\.voidNote">)[\s\S]*?(<\/div>)/,
      `$1This payroll run was cancelled on ${cancelled ? 'the date shown in the books' : '—'} and reversed. ` +
      `${run.cancelReason ? `Reason given: ${esc(run.cancelReason)}. ` : ''}` +
      'This slip is retained as a record only &mdash; it is not evidence of any payment.$2'],

    [/(<div class="v" data-bind="employee\.code">)[^<]*/, `$1${esc(emp.employeeCode)}`],
    [/(<div class="v" data-bind="run\.periodRange">)[^<]*/, `$1${fmtDate(from)} &ndash; ${fmtDate(to)}`],
    // 🔴 says so plainly rather than printing a blank: without a PAN the TDS below cannot be
    // reported against this employee, so it will not reach their 26AS at all
    [/(<div class="v" data-bind="employee\.pan">)[^<]*/, `$1${emp.pan ? esc(emp.pan) : 'Not on record'}`],
    [/(<div class="v" data-bind="employee\.joinedOn">)[^<]*/, `$1${fmtDate(emp.joinedOn)}`],

    [/(<div class="name" data-bind="company\.legalName">)[^<]*/, `$1${esc(co.legalName)}`],
    [/(<address data-bind="company\.registeredAddress">)[\s\S]*?(<\/address>)/, `$1${addressHtml(co.registeredAddress)}$2`],
    [/(<b data-bind="company\.tan">)[^<]*/, `$1${esc(co.tan ?? '—')}`],
    [/(<b data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],
    [/(<b data-bind="company\.cin">)[^<]*/, `$1${esc(co.cin ?? '—')}`],

    [/(<div class="name" data-bind="employee\.name">)[^<]*/, `$1${esc(emp.name)}`],
    [/(<address data-bind="employee\.roleLine">)[\s\S]*?(<\/address>)/,
      `$1${esc([emp.designation, emp.department].filter(Boolean).join(' · ')) || 'Employee'}$2`],
    [/(<b data-bind="employee\.code2">)[^<]*/, `$1${esc(emp.employeeCode)}`],
    [/(<b data-bind="employee\.regime">)[^<]*/, `$1${emp.taxRegime === 'OLD' ? 'Old' : 'New'}`],

    [/(<tbody id="earnings">)[\s\S]*?(<\/tbody>)/, `$1\n        ${earningsHtml}\n      $2`],
    [/(<tbody id="deductions">)[\s\S]*?(<\/tbody>)/, `$1\n        ${deductionsHtml}\n      $2`],
    [/(<tbody id="ytd">)[\s\S]*?(<\/tbody>)/, `$1\n          ${ytdHtml}\n        $2`],

    [/(<td class="num" data-bind="slip\.gross">)[^<]*/, `$1${money(gross.toFixed(2))}`],
    [/(<td class="num" data-bind="slip\.deductionTotal">)[^<]*/, `$1${money(deductionTotal.toFixed(2))}`],
    [/(<span class="k" data-bind="slip\.netLabel">)[^<]*/, `$1${cancelled ? 'Net pay (void)' : 'Net pay'}`],
    [/(<span class="v" data-bind="slip\.net">)[^<]*/, `$1&#8377; ${money(net.toFixed(2))}`],
    [/(<span data-bind="slip\.netInWords">)[^<]*/, `$1${esc(amountInWords(net.toFixed(2)))}`],

    [/(<p data-bind="slip\.tdsExplain">)[\s\S]*?(<\/p>)/, `$1${tdsExplain}$2`],
    [/(<p data-bind="slip\.ptExplain">)[\s\S]*?(<\/p>)/, `$1${ptExplain}$2`],
    [/(<p data-bind="slip\.otherExplain">)[\s\S]*?(<\/p>)/, `$1${otherExplain}$2`],

    [/(<div class="bank" data-bind="slip\.bankLine">)[\s\S]*?(<\/div>)/, `$1${bankLine(emp.bankDetails)}$2`],
    [/(<div class="ids" data-bind="company\.footerIds">)[\s\S]*?(<\/div>)/,
      `$1${esc(co.legalName)}${co.cin ? ` &middot; CIN ${esc(co.cin)}` : ''}$2`],
  ]

  let html = await readFile(TEMPLATE, 'utf8')
  for (const [re, to] of SUBS) html = html.replace(re, to)

  // the standard declaration says the deduction reaches Form 26AS. Where it cannot, the
  // sentence is replaced rather than left standing next to a warning that contradicts it.
  if (panMissing) {
    html = html.replace(
      /; the tax deducted is reported[\s\S]*?once that statement is processed\./,
      '. The tax deducted is reported to the Income Tax Department in the quarterly statement for the ' +
      'quarter in which it was deducted &mdash; but it is reported against a PAN, and there is none on ' +
      'record for you, so it will not reach your Form 26AS until that is fixed.',
    )
  }

  // 🔴 Inlined, not linked — docs/33. setContent() has no base URL, so a relative asset
  // silently does not appear and the slip goes out unbranded. The logo is bound twice.
  const logo = await dataUri('adpedia-logo.svg', 'image/svg+xml')
  html = html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)

  // the deduction total is nil when nothing was deducted, and the arithmetic must still read
  if (!gross.minus(deductionTotal).equals(net)) {
    html = html.replace(/(<span data-bind="slip\.netInWords">)/,
      '<span class="lbl" style="color:#96231F">Gross less deductions does not equal net — report this</span>$1')
  }

  return html
}

async function dataUri(file: string, mime: string): Promise<string> {
  try {
    const bytes = await readFile(join(BRAND_DIR, file))
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}
