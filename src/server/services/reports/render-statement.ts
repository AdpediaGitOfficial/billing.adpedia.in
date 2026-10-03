import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@/server/db'
import { Decimal, formatINR } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { AppError } from '@/server/errors'
import { trialBalance, profitAndLoss, balanceSheet } from './statements'
import type { ResolvedPeriod } from './period'
import { statementStanding } from './status'

const TEMPLATE = join(process.cwd(), 'templates', 'statement', 'statement.html')
const BRAND_DIR = join(process.cwd(), 'public', 'brand')

export const STATEMENTS = ['pnl', 'balance-sheet', 'trial-balance'] as const
export type StatementKey = (typeof STATEMENTS)[number]

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const money = (v: Decimal.Value) => formatINR(v, { symbol: false })

const fmtDay = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

type Row = { label: string; code?: string | null; amount?: Decimal | null; cls?: string; prior?: Decimal | null }

function rowHtml(r: Row, comparative: boolean): string {
  const cells = [
    `<td class="code">${esc(r.code ?? '')}</td>`,
    `<td>${esc(r.label)}</td>`,
    `<td class="num">${r.amount === null || r.amount === undefined ? '' : money(r.amount.toFixed(2))}</td>`,
  ]
  if (comparative) {
    cells.push(`<td class="num">${r.prior === null || r.prior === undefined ? '' : money(r.prior.toFixed(2))}</td>`)
  }
  return `<tr class="${r.cls ?? ''}">${cells.join('')}</tr>`
}

/**
 * The statements as documents — docs/58.
 *
 * One template serves all three, because they are the same object: a list of ledger figures
 * under headings, with a check at the bottom. What differs is which figures and what the
 * check is testing.
 *
 * 🔴 Every one carries its STANDING — final, locked or draft — in the title block, in a
 * banner, and in the notes. A profit figure for the year to date is not the year's profit,
 * and the one thing that distinguishes a management statement from a misleading one is
 * saying so where it cannot be missed.
 */
export async function renderStatementHtml(
  ctx: RequestContext, which: StatementKey, period: ResolvedPeriod,
): Promise<string> {
  const co = await prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } })
  const standing = await statementStanding(ctx.companyId, period)

  // 🔴 the comparative is the PRIOR financial year, and it is only shown when one exists
  // with something in it. A column of zeroes beside this year's figures reads as a company
  // that earned nothing last year, rather than one that was not trading yet.
  const priorFy = await prisma.financialYear.findFirst({
    where: { companyId: ctx.companyId, endsOn: { lt: period.from } },
    orderBy: { startsOn: 'desc' },
  })

  /**
   * 🔴 A statement cannot be as at a date that has not happened.
   *
   * `period.to` is the financial year END. For an open year that is months away, and the
   * first rendering of this produced a balance sheet headed "As at 31 Mar 2027" prepared on
   * 3 October 2026. The figures were right — nothing is posted in the future — but the date
   * on a balance sheet is not decoration: it is what the statement IS.
   */
  const today = new Date()
  const effectiveTo = period.to > today ? today : period.to
  const truncated = effectiveTo < period.to

  let title = '', scope = '', headRight = 'Amount (₹)', check = '', checkBad = false
  let checkTone: 'good' | 'bad' = 'good'
  const rows: Row[] = []
  const notes: string[] = []
  let comparative = false
  let priorLabel = ''

  if (which === 'pnl') {
    const p = await profitAndLoss(ctx, { ...period, to: effectiveTo })
    const prior = priorFy ? await profitAndLoss(ctx, { from: priorFy.startsOn, to: priorFy.endsOn }) : null
    const priorByCode = new Map<string, Decimal>()
    if (prior) {
      for (const s of [prior.revenue, prior.otherIncome, prior.directCosts, prior.operatingExpenses]) {
        for (const l of s.lines) priorByCode.set(l.code, l.amount)
      }
    }
    comparative = !!prior && !prior.totalIncome.plus(prior.totalExpenses).isZero()
    priorLabel = priorFy ? `FY ${priorFy.label} (₹)` : ''

    title = 'Profit &amp; Loss'
    scope = `For the period ${fmtDay(period.from)} to ${fmtDay(effectiveTo)}`

    // 🔴 an empty section is left out, not printed with a zero total. "Operating expenses /
    // Total operating expenses 0.00" with nothing between reads as a company that had none,
    // when it is only a company that has not posted any.
    const section = (s: typeof p.revenue, priorTotal: Decimal | null) => {
      if (s.lines.length === 0) return
      rows.push({ label: s.label, cls: 'section' })
      for (const l of s.lines) rows.push({ code: l.code, label: l.name, amount: l.amount, prior: priorByCode.get(l.code) ?? null })
      rows.push({ label: `Total ${s.label.toLowerCase()}`, amount: s.total, prior: priorTotal, cls: 'subtotal' })
    }
    section(p.revenue, prior?.revenue.total ?? null)
    section(p.directCosts, prior?.directCosts.total ?? null)
    rows.push({ label: 'Gross profit', amount: p.grossProfit, prior: prior?.grossProfit ?? null, cls: 'subtotal' })
    rows.push({ label: '', cls: 'spacer' })
    section(p.operatingExpenses, prior?.operatingExpenses.total ?? null)
    if (p.otherIncome.lines.length > 0) section(p.otherIncome, prior?.otherIncome.total ?? null)
    rows.push({ label: '', cls: 'spacer' })
    rows.push({ label: 'Total income', amount: p.totalIncome, prior: prior?.totalIncome ?? null, cls: 'subtotal' })
    rows.push({ label: 'Total expenses', amount: p.totalExpenses, prior: prior?.totalExpenses ?? null, cls: 'subtotal' })
    rows.push({ label: p.netProfit.isNegative() ? 'Net loss for the period' : 'Net profit for the period',
      amount: p.netProfit, prior: prior?.netProfit ?? null, cls: 'total' })

    // 🔴 the box is green. A net margin of −211% announced in a green reassurance box is
    // worse than no box at all, so the tone follows the result.
    checkTone = p.netProfit.isNegative() ? 'bad' : 'good'
    check = p.marginPct
      ? p.netProfit.isNegative()
        ? `A loss of ${money(p.netProfit.abs().toFixed(2))} — ${p.marginPct.abs().toDecimalPlaces(1)}% of total income.`
        : `Net margin ${p.marginPct.toDecimalPlaces(1)}% of total income.`
      : 'No income in this period, so there is no margin to report.'
    notes.push(
      'Prepared from the general ledger. Every figure here is the sum of posted journal lines and can be traced to them.',
      'Direct costs are salaries and subcontractor charges — what was spent delivering the work. Everything else is an operating expense.',
    )
    if (comparative) notes.push(`The second column is FY ${priorFy!.label}, for comparison. It is presented on the same basis.`)
  }

  if (which === 'balance-sheet') {
    const b = await balanceSheet(ctx, effectiveTo, period.fyStart)
    title = 'Balance Sheet'
    scope = `As at ${fmtDay(effectiveTo)}`

    const section = (s: typeof b.assets) => {
      rows.push({ label: s.label, cls: 'section' })
      for (const l of s.lines) rows.push({ code: l.code, label: l.name + (l.derived ? ' (derived)' : ''), amount: l.amount, cls: l.derived ? 'derived' : '' })
      rows.push({ label: `Total ${s.label.toLowerCase()}`, amount: s.total, cls: 'subtotal' })
    }
    section(b.assets)
    rows.push({ label: '', cls: 'spacer' })
    section(b.liabilities)
    rows.push({ label: '', cls: 'spacer' })
    section(b.equity)
    rows.push({ label: '', cls: 'spacer' })
    rows.push({ label: 'Total liabilities and equity', amount: b.totalLiabilitiesAndEquity, cls: 'total' })

    checkBad = !b.balanced
    checkTone = b.balanced ? 'good' : 'bad'
    check = b.balanced
      ? `Assets ${money(b.totalAssets.toFixed(2))} equal liabilities and equity. The statement balances.`
      : `Assets and the other side differ by ₹${b.difference.toFixed(2)}. This statement does not balance and must not be relied on.`
    notes.push(
      // 🔴 the line everybody asks about, answered on the page rather than in an email
      'Current year profit is shown in equity as a DERIVED line. It is not posted: income and expense ' +
      'accounts hold the year’s result until a year-end closing entry sweeps them into retained ' +
      'earnings, so until then the difference between the two sides of this statement is the profit itself.',
      'Prepared from the general ledger, at the date shown, including every entry posted on that date.',
    )
  }

  if (which === 'trial-balance') {
    const tb = await trialBalance(ctx, period)
    title = 'Trial Balance'
    scope = `For the period ${fmtDay(period.from)} to ${fmtDay(effectiveTo)}`
    headRight = 'Closing Dr (₹)'
    comparative = true
    priorLabel = 'Closing Cr (₹)'

    rows.push({ label: 'Account', cls: 'section' })
    for (const r of tb.rows) {
      rows.push({ code: r.code, label: r.name, amount: r.closingDr, prior: r.closingCr })
    }
    rows.push({ label: 'Total', amount: tb.totals.closingDr, prior: tb.totals.closingCr, cls: 'total' })

    checkBad = !tb.balanced
    checkTone = tb.balanced ? 'good' : 'bad'
    check = tb.balanced
      ? 'Debits equal credits. The ledger balances.'
      : `Debits and credits differ by ₹${tb.difference.toFixed(2)}. Something is posted that should not be — investigate before using any statement from this period.`
    notes.push(
      'Closing balances only; the movement and opening columns are in the CSV export.',
      'A trial balance that balances proves the double entry is intact. It does not prove anything is in the right account.',
    )
  }

  if (rows.length === 0) throw new AppError(`Unknown statement "${which}"`)

  if (truncated) {
    /**
     * 🔴 And what was left out is NAMED.
     *
     * Clamping the date changed the figures, which was the surprise: a monthly payroll run is
     * dated the 28th, so the current month's salaries are posted days ahead of today. They are
     * real entries, they are in the ledger, and the on-screen reports — which run to the year
     * end — include them. A statement that silently shows different numbers from the screen is
     * the thing nobody can explain in a meeting, so it says which entries it stopped short of.
     */
    const ahead = await prisma.journalEntry.aggregate({
      where: { companyId: ctx.companyId, date: { gt: effectiveTo, lte: period.to } },
      _count: { _all: true },
    })
    notes.push(
      `FY ${period.fyLabel} runs to ${fmtDay(period.to)}, which has not arrived. This statement stops at ` +
      `${fmtDay(effectiveTo)} rather than claiming a position at a date in the future.` +
      (ahead._count._all > 0
        ? ` ${ahead._count._all} entr${ahead._count._all === 1 ? 'y is' : 'ies are'} dated after that and ` +
          'excluded here — a payroll run is dated the 28th, so the current month\u2019s salaries are ' +
          'normally among them. The on-screen reports run to the year end and include them.'
        : ''),
    )
  }
  notes.push(
    // 🔴 said on every one of them
    'This is a management statement drawn from the books. It is not prepared in the format prescribed ' +
    'by Schedule III of the Companies Act 2013 and is not a statutory financial statement.',
  )
  // the standing is in the banner above and in the title block; repeating it verbatim in the
  // notes, on the same page, is noise

  const heads = comparative
    ? `<th class="code"></th><th>Particulars</th><th class="num">${esc(headRight)}</th><th class="num">${esc(priorLabel)}</th>`
    : `<th class="code"></th><th>Particulars</th><th class="num">${esc(headRight)}</th>`

  const cls = standing.status === 'FINAL' ? 'st-final' : standing.status === 'LOCKED' ? 'st-locked' : 'st-draft'

  let html = await readFile(TEMPLATE, 'utf8')
  const SUBS: [RegExp, string][] = [
    [/class="sheet st-draft"/, `class="sheet ${cls}"`],
    [/(<h1 data-bind="statement\.title">)[^<]*/, `$1${title}`],
    [/(<div class="scope" data-bind="statement\.scope">)[^<]*/, `$1${esc(scope)}`],
    [/(<div class="copy-mark" data-bind="statement\.standingLabel">)[^<]*/, `$1${esc(standing.label)}`],
    [/(<div class="standing" data-bind="statement\.standingNote">)[\s\S]*?(<\/div>)/, `$1${esc(standing.note)}$2`],
    [/(<div class="v" data-bind="company\.legalName">)[^<]*/, `$1${esc(co.legalName)}`],
    [/(<div class="v" data-bind="company\.cin">)[^<]*/, `$1${esc(co.cin ?? '—')}`],
    [/(<div class="v" data-bind="company\.pan">)[^<]*/, `$1${esc(co.pan)}`],
    [/(<div class="v" data-bind="statement\.generatedOn">)[^<]*/, `$1${fmtDay(new Date())}`],
    [/(<tr id="figheads">)[\s\S]*?(<\/tr>)/, `$1${heads}$2`],
    [/(<tbody id="figures">)[\s\S]*?(<\/tbody>)/,
      `$1\n      ${rows.map((r) => rowHtml(r, comparative)).join('\n      ')}\n    $2`],
    [/(<div class="check" data-bind="statement\.check">)[\s\S]*?(<\/div>)/, `$1${esc(check)}$2`],
    [/(<ol id="notes">)[\s\S]*?(<\/ol>)/,
      `$1\n      ${notes.map((n) => `<li>${esc(n)}</li>`).join('\n      ')}\n    $2`],
    [/(<div class="ids" data-bind="company\.footerIds">)[\s\S]*?(<\/div>)/,
      `$1${esc(co.legalName)}${co.cin ? ` &middot; CIN ${esc(co.cin)}` : ''}$2`],
  ]
  for (const [re, to] of SUBS) html = html.replace(re, to)

  if (checkBad || checkTone === 'bad') html = html.replace('class="check"', 'class="check bad"')

  html = html.replace(/<title>[^<]*/, `<title>${title.replace(/&amp;/g, '&')} — ${esc(co.legalName)}`)

  // inlined, not linked — docs/33. The logo appears twice.
  const logo = await dataUri('adpedia-logo.svg', 'image/svg+xml')
  html = html.replace(/src="assets\/adpedia-logo\.svg"/g, `src="${logo}"`)

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
