import type { PrismaClient } from '@prisma/client'

/**
 * TDS section rates and thresholds.
 *
 * ⚠️ PROVENANCE — read before relying on these.
 *
 * These are the statutory rates and thresholds in force from **1 April 2025**, after the
 * threshold increases in the Finance Act 2025 and the rate cuts in the Finance (No. 2)
 * Act 2024. They are stated to the best of my knowledge and they are NOT a CA's opinion.
 *
 * Two things must still happen before the first live deduction:
 *   1. Adpedia's CA signs off this table.
 *   2. It is checked against the **Finance Act 2026** for FY 2026-27. Rates and thresholds
 *      change nearly every February, and the rows below are dated 01 Apr 2025 precisely so
 *      that a later change is a NEW ROW, never an edit to this one.
 *
 * Resolution is always rateAsOf(code, documentDate) — a document raised in August must keep
 * reproducing the rate that applied in August, however many times it is reopened.
 *
 * 🔴 All rates are on the TAXABLE VALUE, excluding GST (CBDT Circular 23/2017), which is
 * what `baseOn: TAXABLE_VALUE` means. Deducting on the GST-inclusive figure over-deducts
 * by 18% of the tax, and the vendor has to chase a refund to get it back.
 *
 * 🔴 No surcharge or health-and-education cess is added on payments to RESIDENTS. They
 * apply only to s.192 (salary) and s.195 (non-residents) — adding them to a 194J payment
 * is a common and expensive mistake.
 */

const FROM = new Date(Date.UTC(2025, 3, 1)) // 01 Apr 2025 — Finance Act 2025 thresholds

export const TDS_SECTIONS = [
  {
    code: '192',
    description: 'Salary — including director remuneration paid as salary',
    rateCompany: '0', rateIndividualHuf: '0', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: null,
    returnForm: '24Q',
    // 192 is not a flat rate. Monthly TDS = (estimated annual tax − deducted to date)
    // / months remaining. The CA supplies the annual estimate per employee. Surcharge and
    // 4% cess DO apply here, unlike every other section in this table.
  },
  {
    code: '194J',
    description: 'Fees for professional services',
    rateCompany: '10', rateIndividualHuf: '10', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '50000',
    returnForm: '26Q',
    // FA 2025 raised the threshold from ₹30,000 to ₹50,000 w.e.f. 01 Apr 2025.
    // The threshold is per NATURE of payment, per deductee, per year — not per bill.
  },
  {
    code: '194J-TS',
    description: 'Fees for technical services (not professional)',
    rateCompany: '2', rateIndividualHuf: '2', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '50000',
    returnForm: '26Q',
    // 🔴 2%, not 10%. The split between "professional" and "technical" is the single most
    // argued point in a 194J assessment: an editor or a designer is professional work at
    // 10%; routine machine-operated or standardised technical work is 2%. Where a vendor
    // does both, the engagement letter decides — and the CA should be asked once per
    // vendor rather than per bill.
  },
  {
    code: '194J-DIR',
    description: 'Director remuneration NOT paid as salary — s.194J(1)(ba)',
    rateCompany: '10', rateIndividualHuf: '10', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: null,
    returnForm: '26Q',
    // 🔴 NO threshold. A sitting fee or commission to a director attracts TDS from the
    // first rupee, which is why this is its own row rather than 194J with ₹50,000 on it.
    // Shinelal is paid as salary (s.192), so this does not currently bite — it exists so
    // that a future sitting fee is not quietly run through the ₹50,000 threshold.
  },
  {
    code: '194C',
    description: 'Payments to contractors and sub-contractors',
    rateCompany: '2', rateIndividualHuf: '1', rateNoPan: '20',
    thresholdSingle: '30000', thresholdAnnual: '100000',
    returnForm: '26Q',
    // 🔴 1% or 2% is decided by the DEDUCTEE's status, read off the 4th character of their
    // PAN — 'P' individual, 'C' company, 'F' firm. Guessing from the trade name is how a
    // proprietor billing as "XYZ Studios" gets deducted at 2% and raises a grievance.
    // Either threshold crossing triggers deduction: ₹30,000 on one bill, or ₹1,00,000
    // in aggregate across the year.
  },
  {
    code: '194H',
    description: 'Commission or brokerage',
    rateCompany: '2', rateIndividualHuf: '2', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '20000',
    returnForm: '26Q',
    // 🔴 2%, reduced from 5% w.e.f. 01 Oct 2024 (Finance (No. 2) Act 2024). Threshold
    // raised ₹15,000 → ₹20,000 by FA 2025. Deducting 5% here is over-deduction the payee
    // can only recover by filing a return.
  },
  {
    code: '194I-A',
    description: 'Rent — plant, machinery and equipment',
    rateCompany: '2', rateIndividualHuf: '2', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '600000',
    returnForm: '26Q',
    // 🔴 2%, against 10% for premises. This matters for a production company: hired
    // cameras, lighting, grip and studio EQUIPMENT sit here, while the studio FLOOR sits
    // under 194I-B. Putting equipment hire on the 10% row over-deducts fivefold.
  },
  {
    code: '194I-B',
    description: 'Rent — land, building and furniture',
    rateCompany: '10', rateIndividualHuf: '10', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '600000',
    returnForm: '26Q',
    // FA 2025 raised the threshold from ₹2,40,000 to ₹6,00,000 a year w.e.f. 01 Apr 2025.
  },
  {
    code: '194A',
    description: 'Interest other than on securities',
    rateCompany: '10', rateIndividualHuf: '10', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: '10000',
    returnForm: '26Q',
    // Threshold raised ₹5,000 → ₹10,000 by FA 2025 for payers other than banks. This is
    // what applies if Adpedia pays interest on a loan from a director or a private party.
    // Interest RECEIVED from the bank is deducted by the bank, not by Adpedia.
  },
  {
    code: '194Q',
    description: 'Purchase of goods above ₹50 lakh from one seller',
    rateCompany: '0.1', rateIndividualHuf: '0.1', rateNoPan: '5',
    thresholdSingle: null, thresholdAnnual: '5000000',
    returnForm: '26Q',
    // 🔴 The no-PAN rate here is 5%, not 20% — s.206AA caps it at 5% for 194Q specifically.
    // Only applies once Adpedia's own turnover exceeds ₹10 Cr in the preceding year, so it
    // is dormant today; the row exists so it is not missed when that changes.
  },
  {
    code: '195',
    description: 'Payments to non-residents — rate per applicable DTAA',
    rateCompany: '20', rateIndividualHuf: '20', rateNoPan: '20',
    thresholdSingle: null, thresholdAnnual: null,
    returnForm: '27Q',
    // 🔴 20% is the FALLBACK, not the answer. The real rate comes from the DTAA with the
    // payee's country and is often 10% or 15% — but only against a Tax Residency
    // Certificate plus Form 10F, and Form 15CA/15CB must be filed BEFORE the remittance.
    // Surcharge and 4% cess are added on top here, unlike resident sections.
    // No threshold: TDS applies from the first rupee of a chargeable sum.
  },
] as const

export async function seedTdsRates(prisma: PrismaClient) {
  for (const s of TDS_SECTIONS) {
    const existing = await prisma.tdsSectionRate.findUnique({
      where: { code_effectiveFrom: { code: s.code, effectiveFrom: FROM } },
    })
    const data = {
      code: s.code,
      description: s.description,
      effectiveFrom: FROM,
      rateCompany: s.rateCompany,
      rateIndividualHuf: s.rateIndividualHuf,
      rateNoPan: s.rateNoPan,
      thresholdSingle: s.thresholdSingle,
      thresholdAnnual: s.thresholdAnnual,
      returnForm: s.returnForm,
    }
    if (existing) await prisma.tdsSectionRate.update({ where: { id: existing.id }, data })
    else await prisma.tdsSectionRate.create({ data })
  }
  return TDS_SECTIONS.length
}

