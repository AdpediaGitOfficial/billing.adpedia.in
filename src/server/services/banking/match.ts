import { Decimal, ZERO, round2, formatINR } from '@/lib/money'

export interface BankTxnFacts {
  id: string
  amount: Decimal
  direction: 'DEBIT' | 'CREDIT'
  valueDate: Date
  rawNarration: string
  utr: string | null
  counterparty: string | null
  remark: string | null
}

export interface OpenInvoice {
  id: string
  number: string
  customerId: string
  customerName: string
  customerAliases: string[]
  /** gross still unsettled */
  outstanding: Decimal
  /** TDS the customer is expected to deduct and has not yet been credited */
  tdsExpected: Decimal
  tdsSection: string | null
  date: Date
  /** UTR captured on a payment advice or gateway callback */
  knownUtr: string | null
  /** an inward remittance arrives net of correspondent-bank charges; a domestic NEFT does not */
  isExport?: boolean
}

export interface OpenBill {
  id: string
  billNumber: string
  vendorId: string
  vendorName: string
  vendorAliases: string[]
  outstanding: Decimal
  dueDate: Date
}

export interface LearnedRule {
  id: string
  pattern: string
  matchType: 'CONTAINS' | 'REGEX' | 'EXACT'
  direction: 'DEBIT' | 'CREDIT' | null
  accountCode: string | null
  customerId: string | null
  vendorId: string | null
  employeeId: string | null
  autoApply: boolean
  label: string
}

export type SuggestionKind =
  | { kind: 'RECEIPT'; allocations: { invoiceId: string; number: string; amount: Decimal; tds: Decimal }[]; customerId: string; bankCharge: Decimal }
  | { kind: 'BILL_PAYMENT'; billId: string; billNumber: string; vendorId: string; amount: Decimal }
  | { kind: 'LEDGER'; accountCode: string; label: string; customerId?: string; vendorId?: string; employeeId?: string }
  | { kind: 'CONTRA'; pairedTxnId: string }

export interface Suggestion {
  tier: number
  tierName: string
  confidence: number
  /** shown to the user in words — never a bare score */
  reason: string
  suggestion: SuggestionKind
}

const DAY = 86_400_000
/**
 * How short a receipt may fall and still be the same payment.
 *
 * A domestic NEFT or IMPS arrives whole — the sender pays the charge — so a ₹500 gap on a
 * rupee invoice is suspicious and should NOT be absorbed. An inward SWIFT remittance
 * routinely loses ₹500–2,000 to correspondent and intermediary banks before it lands, so
 * exports need a far wider tolerance or every export receipt falls through to a manual match.
 */
const DOMESTIC_TOLERANCE = new Decimal('250')
const DOMESTIC_PCT = new Decimal('0.5')
const EXPORT_TOLERANCE = new Decimal('2000')
const EXPORT_PCT = new Decimal('2')

function normalise(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Token overlap — cheap, and good enough for bank narrations. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalise(a).split(' ').filter((t) => t.length > 2))
  const tb = new Set(normalise(b).split(' ').filter((t) => t.length > 2))
  if (ta.size === 0 || tb.size === 0) return 0
  let hits = 0
  for (const t of ta) if (tb.has(t)) hits++
  return hits / Math.min(ta.size, tb.size)
}

function matchesParty(txn: BankTxnFacts, name: string, aliases: string[]): number {
  const hay = `${txn.counterparty ?? ''} ${txn.rawNarration}`
  let best = nameSimilarity(hay, name)
  for (const a of aliases) best = Math.max(best, nameSimilarity(hay, a))
  return best
}

/** Subsets of up to `max` invoices whose outstanding sums to the target. */
function subsetSum(invoices: OpenInvoice[], target: Decimal, tolerance: Decimal, max = 4): OpenInvoice[] | null {
  const pool = invoices.slice(0, 12)
  const found: OpenInvoice[] = []
  const walk = (start: number, remaining: Decimal, picked: OpenInvoice[]): boolean => {
    if (remaining.abs().lte(tolerance) && picked.length > 1) { found.push(...picked); return true }
    if (picked.length >= max || remaining.lt(tolerance.negated())) return false
    for (let i = start; i < pool.length; i++) {
      if (walk(i + 1, remaining.minus(pool[i].outstanding), [...picked, pool[i]])) return true
    }
    return false
  }
  return walk(0, target, []) ? found : null
}

/**
 * The tiered matcher — docs/02 §A3.
 *
 * Tiers run in order and stop at the first confident hit. Every suggestion carries a
 * score AND a reason in words, because an accountant accepting a match needs to know why
 * it was offered, not just how sure the machine is.
 *
 * 🔴 Tier 2 is the one that earns its keep. A client invoiced ₹1,00,300 pays ₹91,800 and
 * keeps ₹8,500 as TDS. Nothing matches on amount, so a plain reconciler leaves it — and
 * that is most Indian B2B receipts.
 */
export function suggestMatches(args: {
  txn: BankTxnFacts
  invoices: OpenInvoice[]
  bills: OpenBill[]
  rules: LearnedRule[]
  /** other unmatched transactions, for contra detection */
  siblings?: BankTxnFacts[]
}): Suggestion[] {
  const { txn, invoices, bills, rules, siblings = [] } = args
  const out: Suggestion[] = []

  // ── Tier 6 first when a learned rule applies: it is the user's own instruction ──
  //
  // 🔴 Only the MOST SPECIFIC rule fires. "GST @18% on Monthly Service Chrgs" contains
  // "Monthly Service Chrgs", so both rules hit that line — and posting it to bank charges
  // instead of input GST would silently forfeit the credit.
  //
  // Specificity here is the EARLIEST match, not the longest: a bank narration is built
  // prefix-first, so the qualifier that says what the line IS ("GST @18% on …") leads,
  // and the thing being qualified trails. Longest-wins gets this exactly backwards —
  // "Monthly Service Chrgs" is the longer pattern but the less specific rule.
  const hits = rules.flatMap((r) => {
    if (r.direction && r.direction !== txn.direction) return []
    const hay = txn.rawNarration.toUpperCase()
    if (r.matchType === 'EXACT') return hay === r.pattern.toUpperCase() ? [{ r, at: 0 }] : []
    if (r.matchType === 'REGEX') {
      const m = safeRegex(r.pattern)?.exec(txn.rawNarration)
      return m ? [{ r, at: m.index }] : []
    }
    const at = hay.indexOf(r.pattern.toUpperCase())
    return at >= 0 ? [{ r, at }] : []
  })
  const best = hits.sort((a, b) => a.at - b.at || b.r.pattern.length - a.r.pattern.length)[0]?.r
  if (best) {
    out.push({
      tier: 6, tierName: 'Learned rule', confidence: best.autoApply ? 95 : 80,
      reason: `Matches the saved rule "${best.pattern}" — ${best.label}`,
      suggestion: { kind: 'LEDGER', accountCode: best.accountCode ?? '5500', label: best.label,
        customerId: best.customerId ?? undefined, vendorId: best.vendorId ?? undefined, employeeId: best.employeeId ?? undefined },
    })
  }

  if (txn.direction === 'CREDIT') {
    const open = invoices.filter((i) => i.outstanding.gt(0))

    // ── Tier 0 — the UTR is on a payment advice ──
    if (txn.utr) {
      const byUtr = open.find((i) => i.knownUtr && i.knownUtr === txn.utr)
      if (byUtr) {
        out.push({
          tier: 0, tierName: 'UTR identity', confidence: 100,
          reason: `UTR ${txn.utr} is recorded against ${byUtr.number} — no ambiguity`,
          suggestion: { kind: 'RECEIPT', customerId: byUtr.customerId, bankCharge: ZERO,
            allocations: [{ invoiceId: byUtr.id, number: byUtr.number, amount: txn.amount, tds: ZERO }] },
        })
      }
    }

    for (const inv of open) {
      const party = matchesParty(txn, inv.customerName, inv.customerAliases)
      const withinWindow = txn.valueDate >= inv.date && txn.valueDate.getTime() - inv.date.getTime() <= 180 * DAY
      if (!withinWindow) continue

      // ── Tier 1 — the amount is exactly what is outstanding ──
      if (txn.amount.equals(inv.outstanding) && party > 0.3) {
        out.push({
          tier: 1, tierName: 'Exact amount', confidence: 95,
          reason: `${formatINR(txn.amount)} settles ${inv.number} in full`,
          suggestion: { kind: 'RECEIPT', customerId: inv.customerId, bankCharge: ZERO,
            allocations: [{ invoiceId: inv.id, number: inv.number, amount: txn.amount, tds: ZERO }] },
        })
        continue
      }

      // ── 🔴 Tier 2 — the shortfall is exactly the TDS the client was expected to deduct ──
      if (inv.tdsExpected.gt(0)) {
        const gap = inv.outstanding.minus(txn.amount)
        if (gap.minus(inv.tdsExpected).abs().lte('2') && party > 0.25) {
          out.push({
            tier: 2, tierName: 'TDS-aware', confidence: 92,
            reason: `${formatINR(txn.amount)} plus ${formatINR(inv.tdsExpected)} of TDS u/s ${inv.tdsSection ?? '194J'} settles ${inv.number} exactly`,
            suggestion: { kind: 'RECEIPT', customerId: inv.customerId, bankCharge: ZERO,
              allocations: [{ invoiceId: inv.id, number: inv.number, amount: txn.amount, tds: round2(inv.tdsExpected) }] },
          })
          continue
        }
      }

      // ── Tier 3 — short by bank or intermediary charges ──
      const shortfall = inv.outstanding.minus(inv.tdsExpected).minus(txn.amount)
      const tolerance = inv.isExport
        ? Decimal.max(EXPORT_TOLERANCE, inv.outstanding.mul(EXPORT_PCT).div(100))
        : Decimal.max(DOMESTIC_TOLERANCE, inv.outstanding.mul(DOMESTIC_PCT).div(100))
      if (shortfall.gt(0) && shortfall.lte(tolerance) && party > 0.25) {
        out.push({
          tier: 3, tierName: 'Charge tolerance', confidence: 88,
          reason: inv.isExport
            ? `${formatINR(txn.amount)} is ${formatINR(shortfall)} short of ${inv.number} — correspondent and intermediary bank charges on the inward remittance`
            : `${formatINR(txn.amount)} is ${formatINR(shortfall)} short of ${inv.number} — bank charges on the way in`,
          suggestion: { kind: 'RECEIPT', customerId: inv.customerId, bankCharge: round2(shortfall),
            allocations: [{ invoiceId: inv.id, number: inv.number, amount: txn.amount, tds: round2(inv.tdsExpected) }] },
        })
        continue
      }

      // ── Tier 4a — a part payment ──
      if (txn.amount.lt(inv.outstanding) && party > 0.5) {
        out.push({
          tier: 4, tierName: 'Part payment', confidence: 72,
          reason: `${formatINR(txn.amount)} against ${inv.number}, leaving ${formatINR(inv.outstanding.minus(txn.amount))} outstanding`,
          suggestion: { kind: 'RECEIPT', customerId: inv.customerId, bankCharge: ZERO,
            allocations: [{ invoiceId: inv.id, number: inv.number, amount: txn.amount, tds: ZERO }] },
        })
      }
    }

    // ── Tier 4b — one receipt covering several invoices for the same client ──
    const byCustomer = new Map<string, OpenInvoice[]>()
    for (const i of open) byCustomer.set(i.customerId, [...(byCustomer.get(i.customerId) ?? []), i])
    for (const [customerId, list] of byCustomer) {
      if (list.length < 2) continue
      if (matchesParty(txn, list[0].customerName, list[0].customerAliases) < 0.3) continue
      const combo = subsetSum(list, txn.amount, new Decimal('2'))
      if (combo) {
        out.push({
          tier: 4, tierName: 'Combined receipt', confidence: 80,
          reason: `${formatINR(txn.amount)} = ${combo.map((c) => `${c.number} ${formatINR(c.outstanding)}`).join(' + ')}`,
          suggestion: { kind: 'RECEIPT', customerId, bankCharge: ZERO,
            allocations: combo.map((c) => ({ invoiceId: c.id, number: c.number, amount: c.outstanding, tds: ZERO })) },
        })
      }
    }

    // ── Tier 5 — the party is recognisable but nothing is owed ──
    if (out.length === 0 && txn.counterparty) {
      const best = open.map((i) => ({ i, s: matchesParty(txn, i.customerName, i.customerAliases) }))
        .sort((a, b) => b.s - a.s)[0]
      if (best && best.s > 0.5) {
        out.push({
          tier: 5, tierName: 'Party recognised', confidence: 50,
          reason: `Looks like ${best.i.customerName}, but ${formatINR(txn.amount)} does not fit any open invoice — an advance, or an invoice not yet raised`,
          suggestion: { kind: 'LEDGER', accountCode: '2400', label: 'Advance from customer', customerId: best.i.customerId },
        })
      }
    }
  }

  if (txn.direction === 'DEBIT') {
    for (const bill of bills.filter((b) => b.outstanding.gt(0))) {
      const party = matchesParty(txn, bill.vendorName, bill.vendorAliases)
      if (party < 0.3) continue
      if (txn.amount.equals(bill.outstanding)) {
        out.push({
          tier: 1, tierName: 'Exact amount', confidence: 95,
          reason: `${formatINR(txn.amount)} settles ${bill.billNumber} to ${bill.vendorName} in full — net of the TDS withheld`,
          suggestion: { kind: 'BILL_PAYMENT', billId: bill.id, billNumber: bill.billNumber, vendorId: bill.vendorId, amount: txn.amount },
        })
      } else if (txn.amount.lt(bill.outstanding) && party > 0.5) {
        out.push({
          tier: 4, tierName: 'Part payment', confidence: 70,
          reason: `${formatINR(txn.amount)} against ${bill.billNumber}, leaving ${formatINR(bill.outstanding.minus(txn.amount))}`,
          suggestion: { kind: 'BILL_PAYMENT', billId: bill.id, billNumber: bill.billNumber, vendorId: bill.vendorId, amount: txn.amount },
        })
      }
    }
  }

  // ── contra: the mirror leg of a transfer between our own accounts ──
  const mirror = siblings.find((s) =>
    s.id !== txn.id && s.direction !== txn.direction && s.amount.equals(txn.amount) &&
    Math.abs(s.valueDate.getTime() - txn.valueDate.getTime()) <= 2 * DAY)
  if (mirror) {
    out.push({
      tier: 6, tierName: 'Contra', confidence: 85,
      reason: `Mirrors an equal and opposite ${mirror.direction.toLowerCase()} on ${mirror.valueDate.toISOString().slice(0, 10)} — a transfer between own accounts, not income or expense`,
      suggestion: { kind: 'CONTRA', pairedTxnId: mirror.id },
    })
  }

  return out.sort((a, b) => b.confidence - a.confidence)
}

function safeRegex(p: string): RegExp | null {
  try { return new RegExp(p, 'i') } catch { return null }
}

/** docs/02 §H5 — the seed rules for this account, before anything is learned. */
export const SEED_RULES: Omit<LearnedRule, 'id'>[] = [
  { pattern: 'Monthly Service Chrgs', matchType: 'CONTAINS', direction: 'DEBIT', accountCode: '5600', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Bank charges' },
  { pattern: 'Monthly Avg Bal Chrgs', matchType: 'CONTAINS', direction: 'DEBIT', accountCode: '5600', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Bank charges — minimum balance' },
  { pattern: 'GST @18% on', matchType: 'CONTAINS', direction: 'DEBIT', accountCode: '1210', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Input GST on bank charges' },
  { pattern: 'Int.pd', matchType: 'CONTAINS', direction: 'CREDIT', accountCode: '4910', customerId: null, vendorId: null, employeeId: null, autoApply: true, label: 'Interest income' },
]
