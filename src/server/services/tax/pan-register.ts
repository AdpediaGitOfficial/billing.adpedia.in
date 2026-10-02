import { prisma } from '@/server/db'
import { Decimal, ZERO } from '@/lib/money'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'
import { isValidPanFormat, panEntity, panEntityLabel, isCompanyOrFirm, PAN_RE } from './pan'
import { rateAsOf } from './tds-resolver'
import { panCardCounts } from './pan-card'
import { currentFinancialYear } from '@/server/services/accounting/period'

/**
 * The PAN register.
 *
 * 🔴 A format-valid PAN is still not a PAN that exists. `ABCDE1234F` passes every check in
 * this file and may belong to nobody, and quoting a wrong but well-formed PAN is worse than
 * quoting none: the deduction is reported against a stranger, the real deductee never sees
 * the credit in their 26AS, and the correction is a revised return.
 *
 * 🔴 But that is NOT what s.206AA turns on, and conflating the two was a real bug (docs/47).
 * The section applies where the deductee has not **furnished** a PAN — not where nobody has
 * checked one. Keying the 20% rate off a portal check this system deliberately does not make
 * meant that every PAN entered here left the payee at 20% forever, and the only code that
 * could clear it was the vendor form.
 *
 * So `panVerified` means **furnished and format-valid**, which is the statutory test, and
 * `panEvidence` records what stands behind it — DECLARED, or a card copy on file.
 */

export type PartyKind = 'EMPLOYEE' | 'VENDOR'

export interface PanGap {
  kind: PartyKind
  id: string
  name: string
  pan: string | null
  verified: boolean
  /** what stands behind the number — docs/47 */
  evidence: 'NONE' | 'DECLARED' | 'CARD_ON_FILE'
  /** copies of the PAN card attached to this party */
  cards: number
  /**
   * 🔴 Separate from `issues`, because they are not the same kind of thing. An issue is
   * something WRONG — a malformed PAN, a duplicate, a rate being over-deducted. A chase is
   * paperwork still to collect, with nothing mis-stated in the meantime. Rendering the two
   * alike put an amber "check" against vendors whose rate was already right, and a list
   * where everything is flagged is a list nobody reads.
   */
  chases: string[]
  /** the section that governs payments to them */
  section: string | null
  /** what will actually be deducted today */
  effectiveRatePct: Decimal
  /** what would be deducted once a PAN is on file */
  correctRatePct: Decimal
  /** paid so far this financial year, excluding GST */
  paidThisFy: Decimal
  /** 🔴 extra tax withheld purely because the PAN is missing */
  excessWithheld: Decimal
  issues: string[]
}

export interface PanRegister {
  rows: PanGap[]
  missing: number
  mismatched: number
  duplicated: number
  /** has a PAN, but no copy of the card — a chase, not a rate problem */
  undocumented: number
  totalExcessWithheld: Decimal
}

/**
 * Who is missing a PAN, and what it is costing.
 *
 * Without a PAN, s.206AA forces **20%** regardless of the section — double the 194J rate and
 * twenty times the 194C individual rate. That money is not lost, but the payee only gets it
 * back by filing a return and waiting for a refund, which is a real thing to do to a
 * freelancer.
 */
export async function panRegister(ctx: RequestContext): Promise<PanRegister> {
  assertCan(ctx.role, 'tax', 'read')

  const fy = await currentFinancialYear(ctx.companyId)
  const onDate = fy?.startsOn ?? new Date()

  const [employees, vendors] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId: ctx.companyId }, orderBy: { employeeCode: 'asc' },
      select: { id: true, name: true, pan: true, employeeCode: true, panEvidence: true },
    }),
    prisma.vendor.findMany({
      where: { companyId: ctx.companyId }, orderBy: { name: 'asc' },
      select: {
        id: true, name: true, pan: true, panVerified: true, vendorType: true,
        defaultTdsSection: true, isForeignSupplier: true, panEvidence: true,
      },
    }),
  ])

  // how much each vendor has actually been billed this year, so the exposure is real
  const billed = await prisma.vendorBill.groupBy({
    by: ['vendorId'],
    where: {
      companyId: ctx.companyId, status: { notIn: ['DRAFT', 'CANCELLED'] },
      ...(fy ? { financialYearId: fy.id } : {}),
    },
    _sum: { taxableValue: true },
  })
  const billedBy = new Map(billed.map((b) => [b.vendorId, new Decimal(b._sum.taxableValue?.toString() ?? '0')]))
  const cardsBy = await panCardCounts(ctx)

  const rows: PanGap[] = []
  const seen = new Map<string, string[]>()   // pan -> names, for duplicate detection

  for (const e of employees) {
    const issues: string[] = []
    if (!e.pan) {
      // 🔴 Salary is the one case where a missing PAN does NOT mean a flat 20%: s.192 runs
      // on the slab, and s.206AA sets a FLOOR of 20% rather than replacing the computation.
      // Saying "20%" here would be wrong, so the cost is stated differently.
      issues.push('No PAN — s.206AA applies a 20% floor to the salary TDS, and Form 16 cannot be issued')
    } else if (!isValidPanFormat(e.pan)) {
      issues.push(`"${e.pan}" is not a valid PAN format`)
    } else if (panEntity(e.pan) !== 'INDIVIDUAL') {
      issues.push(`PAN says ${panEntityLabel(e.pan)} — an employee's PAN must be an individual's (4th character P)`)
    }
    track(seen, e.pan, e.name)

    const eCards = cardsBy.get(`Employee:${e.id}`) ?? 0
    const eChases: string[] = []
    if (e.pan && isValidPanFormat(e.pan) && eCards === 0) {
      eChases.push('No copy of the PAN card on file — the number was taken on trust')
    } else if (eCards > 0 && e.panEvidence !== 'CARD_ON_FILE') {
      eChases.push('A PAN card is attached but nobody has confirmed it matches the number')
    }

    rows.push({
      chases: eChases,
      kind: 'EMPLOYEE', id: e.id, name: e.name, pan: e.pan,
      verified: isValidPanFormat(e.pan),
      evidence: e.panEvidence, cards: eCards,
      section: '192',
      effectiveRatePct: ZERO, correctRatePct: ZERO,
      paidThisFy: ZERO, excessWithheld: ZERO, issues,
    })
  }

  for (const v of vendors) {
    const issues: string[] = []
    const chases: string[] = []
    const section = v.defaultTdsSection
    const paid = billedBy.get(v.id) ?? ZERO

    let effective = ZERO, correct = ZERO
    if (section && !v.isForeignSupplier) {
      const rate = await rateAsOf(section, onDate)
      // 🔴 The PAN is the ONLY source for 1% vs 2% under 194C. VendorType is a business
      // category (FREELANCER, AGENCY, CLOUD…), not an entity type — it cannot answer this,
      // and reading it as if it could is how a proprietor gets deducted at the company rate.
      correct = new Decimal(
        (isCompanyOrFirm(v.pan) ? rate.rateCompany : rate.rateIndividualHuf).toString(),
      )
      effective = v.pan && isValidPanFormat(v.pan) ? correct : new Decimal(rate.rateNoPan.toString())
    }

    if (!v.pan) {
      if (v.isForeignSupplier) {
        // a non-resident has no Indian PAN; s.206AA is relaxed where the treaty conditions
        // are met, which is what the TRC and Form 10F are for
        issues.push('Foreign supplier — no Indian PAN expected, but a TRC and Form 10F are needed for the treaty rate under s.195')
      } else if (!section) {
        // 🔴 No TDS section means nothing is deducted from them, so a missing PAN costs
        // nothing today. Saying "206AA forces 0% instead of 0%" would be noise that trains
        // people to ignore this list.
        issues.push('No PAN, but no TDS section is set for this vendor either — nothing is being deducted, so nothing is over-withheld')
      } else if (effective.gt(correct)) {
        issues.push(`No PAN — s.206AA forces ${effective.toFixed(0)}% instead of ${correct.toFixed(0)}%`)
      } else {
        issues.push('No PAN on file')
      }
    } else if (!isValidPanFormat(v.pan)) {
      issues.push(`"${v.pan}" is not a valid PAN format`)
    } else {
      // The PAN decides the rate, but a contradiction with how the vendor was CATEGORISED
      // usually means one of the two is a data-entry error, and it is cheap to say so.
      const fromPan = panEntity(v.pan)
      const expectedIndividual = v.vendorType === 'FREELANCER'
      if (expectedIndividual && (fromPan === 'COMPANY' || fromPan === 'FIRM')) {
        issues.push(`Listed as a freelancer but the PAN is a ${panEntityLabel(v.pan).toLowerCase()} — 194C will deduct at the ${rate0(correct)}% company rate, which may be right, but check the category`)
      }
      // 🔴 Not "verify it on the portal". This system does not, by design (docs/47), and a
      // nag nobody can ever clear is how a list stops being read. What CAN be done is hold
      // the card — so that is what it asks for, as a chase rather than a fault.
      if ((cardsBy.get(`Vendor:${v.id}`) ?? 0) === 0) {
        chases.push('No copy of the PAN card on file — the number was taken on trust')
      } else if (v.panEvidence !== 'CARD_ON_FILE') {
        chases.push('A PAN card is attached but nobody has confirmed it matches the number')
      }
    }
    track(seen, v.pan, v.name)

    rows.push({
      chases,
      kind: 'VENDOR', id: v.id, name: v.name, pan: v.pan, verified: v.panVerified,
      evidence: v.panEvidence, cards: cardsBy.get(`Vendor:${v.id}`) ?? 0,
      section,
      effectiveRatePct: effective, correctRatePct: correct,
      paidThisFy: paid,
      excessWithheld: paid.mul(effective.minus(correct)).div(100),
      issues,
    })
  }

  // 🔴 The same PAN on two parties means one of them is wrong, or the same person is on
  // file twice. Either way the 26Q aggregates their payments under one deductee and the
  // thresholds are computed against the wrong total.
  let duplicated = 0
  for (const [pan, names] of seen) {
    if (names.length < 2) continue
    duplicated += names.length
    for (const r of rows) {
      if (r.pan?.toUpperCase() === pan) {
        r.issues.push(`This PAN is also on file for ${names.filter((n) => n !== r.name).join(', ')}`)
      }
    }
  }

  return {
    rows,
    missing: rows.filter((r) => !r.pan).length,
    mismatched: rows.filter((r) => r.pan && r.issues.length > 0).length,   // wrong, not merely undocumented
    duplicated,
    undocumented: rows.filter((r) => isValidPanFormat(r.pan) && r.cards === 0).length,
    totalExcessWithheld: rows.reduce((a, r) => a.plus(r.excessWithheld), ZERO),
  }
}

function track(seen: Map<string, string[]>, pan: string | null, name: string) {
  if (!pan || !isValidPanFormat(pan)) return
  const key = pan.trim().toUpperCase()
  seen.set(key, [...(seen.get(key) ?? []), name])
}

/* ── intake ──────────────────────────────────────────────────────────────────── */

export interface PanAssignment { kind: PartyKind; id: string; pan: string }

export interface PanSaveResult {
  saved: number
  rejected: { id: string; name: string; reason: string }[]
}

/**
 * Record PANs.
 *
 * Deliberately strict: a malformed PAN is rejected rather than stored and flagged later.
 * There is no benefit to accepting one — it cannot be quoted in a return, and a stored bad
 * value looks like progress on the chase list while being worth less than a blank.
 */
export async function savePans(ctx: RequestContext, assignments: PanAssignment[]): Promise<PanSaveResult> {
  assertCan(ctx.role, 'tax', 'write')

  const rejected: PanSaveResult['rejected'] = []
  let saved = 0

  for (const a of assignments) {
    const pan = a.pan.trim().toUpperCase()
    if (!pan) continue

    if (!isValidPanFormat(pan)) {
      rejected.push({ id: a.id, name: a.id, reason: `"${a.pan}" is not a valid PAN — five letters, four digits, one letter` })
      continue
    }

    if (a.kind === 'EMPLOYEE') {
      const emp = await prisma.employee.findFirst({ where: { id: a.id, companyId: ctx.companyId } })
      if (!emp) { rejected.push({ id: a.id, name: a.id, reason: 'Employee not found' }); continue }
      if (panEntity(pan) !== 'INDIVIDUAL') {
        rejected.push({ id: a.id, name: emp.name, reason: `PAN is a ${panEntityLabel(pan).toLowerCase()} — an employee's must be an individual's` })
        continue
      }
      await prisma.employee.update({
        where: { id: a.id },
        data: { pan, ...(emp.panEvidence === 'CARD_ON_FILE' ? {} : { panEvidence: 'DECLARED' as const }) },
      })
      await audit(ctx, { entity: 'Employee', entityId: a.id, action: 'UPDATE', after: { pan } })
      saved += 1
    } else {
      const ven = await prisma.vendor.findFirst({ where: { id: a.id, companyId: ctx.companyId } })
      if (!ven) { rejected.push({ id: a.id, name: a.id, reason: 'Vendor not found' }); continue }
      // 🔴 The PAN is now FURNISHED, which is what s.206AA turns on — so the 20% stops here.
      //
      // This used to write `panVerified: false` on the reasoning that only a portal check
      // could set it. The portal check does not exist in this system and is not going to, so
      // the flag could never be cleared: every PAN collected through this screen left the
      // payee at 20% for good, while the vendor form set the same flag from format alone.
      // Two code paths, opposite answers, and the register was the one that over-deducted.
      //
      // The evidence level records what actually stands behind it; a card copy raises it to
      // CARD_ON_FILE, and never lowers it back from here.
      await prisma.vendor.update({
        where: { id: a.id },
        data: {
          pan, panVerified: true,
          ...(ven.panEvidence === 'CARD_ON_FILE' ? {} : { panEvidence: 'DECLARED' as const }),
        },
      })
      await audit(ctx, { entity: 'Vendor', entityId: a.id, action: 'UPDATE', after: { pan } })
      saved += 1
    }
  }

  return { saved, rejected }
}

/**
 * Parse a pasted list.
 *
 * People keep PANs in a spreadsheet or a WhatsApp message, so accept both
 * "Name, PAN" and "Name<tab>PAN", in any order, and match the name loosely.
 */
export function parsePanPaste(text: string): { name: string; pan: string }[] {
  const out: { name: string; pan: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const pan = line.toUpperCase().match(PAN_RE)?.[0]
      ?? line.toUpperCase().match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/)?.[0]
    if (!pan) continue
    // whatever is left once the PAN and separators are removed is the name
    const name = line.replace(new RegExp(pan, 'i'), '').replace(/[,\t;|]+/g, ' ').trim()
    if (name) out.push({ name, pan })
  }
  return out
}

/** Loose name match, so "Kiran N S" finds "Kiran N.S." */
export function normaliseName(n: string): string {
  return n.toLowerCase().replace(/[^a-z]/g, '')
}

export function matchByName<T extends { id: string; name: string }>(
  parsed: { name: string; pan: string }[], people: T[],
): { matched: { person: T; pan: string }[]; unmatched: { name: string; pan: string }[] } {
  const matched: { person: T; pan: string }[] = []
  const unmatched: { name: string; pan: string }[] = []

  for (const p of parsed) {
    const key = normaliseName(p.name)
    const hit = people.find((x) => normaliseName(x.name) === key)
      ?? people.find((x) => normaliseName(x.name).startsWith(key) || key.startsWith(normaliseName(x.name)))
    if (hit) matched.push({ person: hit, pan: p.pan })
    else unmatched.push(p)
  }
  return { matched, unmatched }
}

function rate0(v: Decimal): string { return v.toFixed(0) }

export function assertPanUsable(pan: string): void {
  if (!isValidPanFormat(pan)) throw new AppError(`"${pan}" is not a valid PAN`)
}
