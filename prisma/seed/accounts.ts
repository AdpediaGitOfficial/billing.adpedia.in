import type { AccountType, PrismaClient } from '@prisma/client'

type Row = { code: string; name: string; type: AccountType; subType?: string; parent?: string }

/** docs/12 §1. isSystem — posting rules reference these by code, so they are not user-deletable. */
export const CHART: Row[] = [
  // ASSETS
  { code: '1000', name: 'Bank Accounts', type: 'ASSET' },
  { code: '1010', name: 'Axis Bank — Current 921020015185413', type: 'ASSET', subType: 'BANK', parent: '1000' },
  { code: '1050', name: 'Cash in Hand', type: 'ASSET', subType: 'CASH' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', subType: 'AR' },
  { code: '1200', name: 'Input GST', type: 'ASSET' },
  { code: '1210', name: 'Input CGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1220', name: 'Input SGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1230', name: 'Input IGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1240', name: 'Input IGST — RCM', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1300', name: 'TDS Receivable', type: 'ASSET' },
  { code: '1310', name: 'TDS Receivable — 194J', type: 'ASSET', subType: 'TDS_REC', parent: '1300' },
  { code: '1320', name: 'TDS Receivable — 194C', type: 'ASSET', subType: 'TDS_REC', parent: '1300' },
  { code: '1400', name: 'Advances to Vendors', type: 'ASSET' },
  { code: '1500', name: 'Fixed Assets', type: 'ASSET' },

  // LIABILITIES
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', subType: 'AP' },
  { code: '2100', name: 'Output GST', type: 'LIABILITY' },
  { code: '2110', name: 'Output CGST', type: 'LIABILITY', subType: 'GST_OUTPUT', parent: '2100' },
  { code: '2120', name: 'Output SGST', type: 'LIABILITY', subType: 'GST_OUTPUT', parent: '2100' },
  { code: '2130', name: 'Output IGST', type: 'LIABILITY', subType: 'GST_OUTPUT', parent: '2100' },
  { code: '2140', name: 'IGST Payable — RCM', type: 'LIABILITY', subType: 'GST_RCM', parent: '2100' },
  { code: '2200', name: 'TDS Payable', type: 'LIABILITY' },
  { code: '2210', name: 'TDS Payable — 192 (salary)', type: 'LIABILITY', subType: 'TDS_PAY', parent: '2200' },
  { code: '2220', name: 'TDS Payable — 194J', type: 'LIABILITY', subType: 'TDS_PAY', parent: '2200' },
  { code: '2230', name: 'TDS Payable — 194C', type: 'LIABILITY', subType: 'TDS_PAY', parent: '2200' },
  { code: '2240', name: 'TDS Payable — 195 (non-resident)', type: 'LIABILITY', subType: 'TDS_PAY', parent: '2200' },
  { code: '2300', name: 'Salary Payable', type: 'LIABILITY' },
  { code: '2310', name: 'Profession Tax Payable', type: 'LIABILITY' },
  { code: '2400', name: 'Advances from Customers', type: 'LIABILITY' },
  { code: '2500', name: "Director's Current Account", type: 'LIABILITY' },

  // EQUITY
  { code: '3000', name: 'Share Capital', type: 'EQUITY' },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY' },
  { code: '3200', name: 'Current Year Profit', type: 'EQUITY' },

  // INCOME
  { code: '4000', name: 'Revenue', type: 'INCOME' },
  { code: '4010', name: 'Software Development', type: 'INCOME', parent: '4000' },
  { code: '4020', name: 'Staff Augmentation', type: 'INCOME', parent: '4000' },
  { code: '4030', name: 'Design Services', type: 'INCOME', parent: '4000' },
  { code: '4040', name: 'Film & Video Production', type: 'INCOME', parent: '4000' },
  { code: '4900', name: 'Other Income', type: 'INCOME' },
  { code: '4910', name: 'Interest Income', type: 'INCOME', parent: '4900' },
  { code: '4920', name: 'Forex Gain', type: 'INCOME', parent: '4900' },

  // EXPENSES
  { code: '5100', name: 'Salary & Wages', type: 'EXPENSE' },
  { code: '5110', name: "Director's Remuneration", type: 'EXPENSE', parent: '5100' },
  { code: '5120', name: 'Staff Salaries', type: 'EXPENSE', parent: '5100' },
  { code: '5200', name: 'Professional & Contract', type: 'EXPENSE' },
  { code: '5210', name: 'Freelancer Fees — 194J', type: 'EXPENSE', parent: '5200' },
  { code: '5220', name: 'Subcontract — 194C', type: 'EXPENSE', parent: '5200' },
  { code: '5300', name: 'Infrastructure', type: 'EXPENSE' },
  { code: '5310', name: 'Cloud & Hosting', type: 'EXPENSE', parent: '5300' },
  { code: '5320', name: 'Internet & Telephone', type: 'EXPENSE', parent: '5300' },
  { code: '5330', name: 'Domains & Software Subscriptions', type: 'EXPENSE', parent: '5300' },
  { code: '5400', name: 'Travel & Conveyance', type: 'EXPENSE' },
  { code: '5500', name: 'Office & Admin', type: 'EXPENSE' },
  { code: '5600', name: 'Bank Charges', type: 'EXPENSE' },
  { code: '5700', name: 'Marketing', type: 'EXPENSE' },
  { code: '5900', name: 'Forex Loss', type: 'EXPENSE' },
]

export async function seedAccounts(prisma: PrismaClient, companyId: string) {
  // two passes so parents exist before children reference them
  for (const r of CHART.filter((r) => !r.parent)) {
    await prisma.account.upsert({
      where: { companyId_code: { companyId, code: r.code } },
      update: { name: r.name, type: r.type, subType: r.subType },
      create: { companyId, code: r.code, name: r.name, type: r.type, subType: r.subType, isSystem: true },
    })
  }
  for (const r of CHART.filter((r) => r.parent)) {
    const parent = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId, code: r.parent! } } })
    await prisma.account.upsert({
      where: { companyId_code: { companyId, code: r.code } },
      update: { name: r.name, type: r.type, subType: r.subType, parentId: parent.id },
      create: { companyId, code: r.code, name: r.name, type: r.type, subType: r.subType, parentId: parent.id, isSystem: true },
    })
  }
  return CHART.length
}
