import type { Constitution, GstTreatment, ItcDefault, Prisma, PrismaClient } from '@prisma/client'

/** Usable inside `$transaction` — a company is born in one, docs/82 §2. */
type Db = PrismaClient | Prisma.TransactionClient

/** docs/04 §5. CHECK_SUPPLIER is deliberate: only the supplier's GSTIN decides RCM. */
export const EXPENSE_CATEGORIES = [
  { code: 'SALARY',   name: 'Salary & Wages',            account: '5100', gst: 'NONE',           itc: 'BLOCKED', tds: '192',  rcm: false, recurring: false },
  { code: 'VENDOR',   name: 'Vendor / Subcontract',      account: '5200', gst: 'STANDARD_18',    itc: 'FULL',    tds: '194J', rcm: true,  recurring: false },
  { code: 'CLOUD',    name: 'Cloud & Hosting',           account: '5310', gst: 'CHECK_SUPPLIER', itc: 'FULL',    tds: null,   rcm: true,  recurring: true },
  { code: 'INTERNET', name: 'Internet & Telephone',      account: '5320', gst: 'STANDARD_18',    itc: 'FULL',    tds: null,   rcm: false, recurring: true },
  { code: 'DOMAIN',   name: 'Domains & Software',        account: '5330', gst: 'CHECK_SUPPLIER', itc: 'FULL',    tds: null,   rcm: true,  recurring: true },
  { code: 'TRAVEL',   name: 'Travel & Conveyance',       account: '5400', gst: 'MIXED',          itc: 'PARTIAL', tds: null,   rcm: false, recurring: false },
  { code: 'OFFICE',   name: 'Office & Admin',            account: '5500', gst: 'STANDARD_18',    itc: 'FULL',    tds: null,   rcm: false, recurring: false },
  { code: 'BANKCHG',  name: 'Bank Charges',              account: '5600', gst: 'STANDARD_18',    itc: 'FULL',    tds: null,   rcm: false, recurring: true },
  { code: 'MARKETING',name: 'Marketing & Advertising',   account: '5700', gst: 'CHECK_SUPPLIER', itc: 'FULL',    tds: '194C', rcm: true,  recurring: false },
] as const

export interface CategoryOptions {
  /** false ⇒ there is no input credit to default to, and no RCM to flag. See below. */
  gstRegistered?: boolean
  /** false ⇒ this entity is not a person liable to deduct TDS. See `deductsTdsByDefault`. */
  deductsTds?: boolean
}

/**
 * 🔴 Who is liable to DEDUCT TDS, which is a question about the payer and not the payment.
 *
 * s.194C and s.194J each carry a proviso excluding an individual or HUF whose turnover in the
 * preceding year did not exceed the s.44AB limits — ₹1 crore of business turnover, ₹50 lakh of
 * professional receipts. A company, firm or LLP has no such exclusion: it deducts from the
 * first rupee, whatever its size.
 *
 * So a proprietorship starts out NOT liable, and the categories must not default to deducting.
 * Defaulting to 194J would have entity B withholding tax it has no TAN to deposit, creating a
 * TDS Payable it cannot clear and a 26Q it cannot file — and the deductee loses the credit.
 *
 * 🔴 It is not permanent. The moment the PRECEDING year crosses the s.44AB limit the
 * proprietorship becomes liable, and that is the same ₹1 crore docs/82 §8 is already watching
 * with an ₹80 lakh alert. When it trips, this flag is what changes.
 */
export function deductsTdsByDefault(constitution: Constitution): boolean {
  return constitution !== 'PROPRIETORSHIP'
}

/**
 * The nine categories, with the defaults an entity can actually act on — docs/82 §5b.
 *
 * 🔴 The list is the same; what differs is every field that assumes a registration. Seeded
 * unchanged for entity B, the capture screen offered input credit on each one, and
 * `createExpense` took `itcDefault: 'FULL'` as consent: ₹1,800 of GST on a ₹10,000 bill
 * debited to `1210 Input CGST` and `1220 Input SGST` as an ASSET. An asset that cannot ever be
 * utilised, because s.16(1) gives credit to a registered person — so the cost was understated
 * by the tax and the balance sheet carried a receivable from nobody.
 */
export async function seedExpenseCategories(prisma: Db, companyId: string, opts: CategoryOptions = {}) {
  const gstRegistered = opts.gstRegistered ?? true
  const deductsTds = opts.deductsTds ?? true

  for (const c of EXPENSE_CATEGORIES) {
    const account = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId, code: c.account } } })

    // 🔴 for an unregistered entity the supplier's GST is simply part of the cost: nothing to
    // split out, nothing to claim, and no RCM to raise — being liable to pay tax under s.9(3)
    // would make registration compulsory under s.24(iii) rather than optional.
    const gstTreatment: GstTreatment = gstRegistered ? c.gst : 'NONE'
    const itcDefault: ItcDefault = gstRegistered ? c.itc : 'BLOCKED'
    const tdsSection = deductsTds ? c.tds : null
    const rcmPossible = gstRegistered && c.rcm

    await prisma.expenseCategory.upsert({
      where: { companyId_code: { companyId, code: c.code } },
      update: { name: c.name, accountId: account.id, gstTreatment, itcDefault, tdsSection, rcmPossible },
      create: {
        companyId, code: c.code, name: c.name, accountId: account.id,
        gstTreatment, itcDefault, tdsSection, rcmPossible,
        isRecurring: c.recurring,
      },
    })
  }
  return EXPENSE_CATEGORIES.length
}
