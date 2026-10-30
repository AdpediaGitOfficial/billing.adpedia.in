import type { Prisma, PrismaClient } from '@prisma/client'

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

export async function seedExpenseCategories(prisma: Db, companyId: string) {
  for (const c of EXPENSE_CATEGORIES) {
    const account = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId, code: c.account } } })
    await prisma.expenseCategory.upsert({
      where: { companyId_code: { companyId, code: c.code } },
      update: { name: c.name, accountId: account.id },
      create: {
        companyId, code: c.code, name: c.name, accountId: account.id,
        gstTreatment: c.gst, itcDefault: c.itc, tdsSection: c.tds,
        rcmPossible: c.rcm, isRecurring: c.recurring,
      },
    })
  }
  return EXPENSE_CATEGORIES.length
}
