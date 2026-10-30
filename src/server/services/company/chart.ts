import type { AccountType, Constitution, Prisma, PrismaClient } from '@prisma/client'

/** Usable inside `$transaction`, because a company is born in one — docs/82 §2. */
type Db = PrismaClient | Prisma.TransactionClient

export type Row = { code: string; name: string; type: AccountType; subType?: string; parent?: string }

/** docs/12 §1. isSystem — posting rules reference these by code, so they are not user-deletable. */
export const CHART: Row[] = [
  // ASSETS
  { code: '1000', name: 'Bank Accounts', type: 'ASSET' },
  // 🔴 generic on purpose. Adpedia's own label is passed in by the seed; baked into the chart
  // it followed every company created afterwards, account number and all.
  { code: '1010', name: 'Bank — Current', type: 'ASSET', subType: 'BANK', parent: '1000' },
  { code: '1050', name: 'Cash in Hand', type: 'ASSET', subType: 'CASH' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', subType: 'AR' },
  { code: '1200', name: 'Input GST', type: 'ASSET' },
  { code: '1210', name: 'Input CGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1220', name: 'Input SGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1230', name: 'Input IGST', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  { code: '1240', name: 'Input IGST — RCM', type: 'ASSET', subType: 'GST_INPUT', parent: '1200' },
  // docs/46 — the portal's electronic cash ledger, kept head-wise because the law is
  // head-wise: cash under one major head cannot discharge another without Form PMT-09.
  { code: '1250', name: 'Electronic Cash Ledger', type: 'ASSET' },
  { code: '1251', name: 'Cash Ledger — IGST', type: 'ASSET', subType: 'GST_CASH', parent: '1250' },
  { code: '1252', name: 'Cash Ledger — CGST', type: 'ASSET', subType: 'GST_CASH', parent: '1250' },
  { code: '1253', name: 'Cash Ledger — SGST', type: 'ASSET', subType: 'GST_CASH', parent: '1250' },
  { code: '1254', name: 'Cash Ledger — interest, fee & penalty', type: 'ASSET', subType: 'GST_CASH', parent: '1250' },
  { code: '1300', name: 'TDS Receivable', type: 'ASSET' },
  { code: '1310', name: 'TDS Receivable — 194J', type: 'ASSET', subType: 'TDS_REC', parent: '1300' },
  { code: '1320', name: 'TDS Receivable — 194C', type: 'ASSET', subType: 'TDS_REC', parent: '1300' },
  // docs/71 — advance tax is money paid on account against a liability the return has not
  // settled. An ASSET: booking it as an expense understates the year's profit by whatever has
  // been paid, and then double-counts when the final tax is provided for.
  { code: '1350', name: 'Advance Income Tax Paid', type: 'ASSET' },
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

/**
 * 🔴 The equity section is the one part of the chart that depends on WHO OWNS the entity.
 *
 * A company has share capital and no drawings — a shareholder is paid a dividend, which is a
 * distribution of taxed profit, not a withdrawal. A proprietor has the opposite: no share
 * capital, and drawings, because the proprietor and the business are one person and money
 * moves between them freely.
 *
 * 🔴 Drawings is EQUITY, never an expense. It is how rent, groceries and medical bills are
 * recorded in full without moving taxable profit by a paisa — `profitAndLoss` reads INCOME and
 * EXPENSE only, so an equity contra cannot reach it. Booked as an expense instead, household
 * spending would understate the profit the proprietor declares. docs/82 §4.
 */
export function equityRows(constitution: Constitution): Row[] {
  const common: Row[] = [
    { code: '3100', name: 'Retained Earnings', type: 'EQUITY' },
    { code: '3200', name: 'Current Year Profit', type: 'EQUITY' },
  ]
  switch (constitution) {
    case 'PRIVATE_LIMITED':
    case 'PUBLIC_LIMITED':
      return [{ code: '3000', name: 'Share Capital', type: 'EQUITY' }, ...common]
    case 'LLP':
    case 'PARTNERSHIP':
      return [
        { code: '3000', name: "Partners' Capital", type: 'EQUITY' },
        ...common,
        { code: '3300', name: "Partners' Drawings", type: 'EQUITY', subType: 'DRAWINGS' },
      ]
    case 'PROPRIETORSHIP':
      return [
        { code: '3000', name: "Proprietor's Capital", type: 'EQUITY' },
        ...common,
        { code: '3300', name: 'Drawings', type: 'EQUITY', subType: 'DRAWINGS' },
      ]
  }
}

export interface ChartOptions {
  /** decides the equity section — see `equityRows` */
  constitution?: Constitution
  /** what GL 1010 is called for this company, e.g. "Axis Bank — Current 9210…" */
  bankLabel?: string
}

export function chartFor(opts: ChartOptions = {}): Row[] {
  const rows = CHART.map((r) =>
    r.code === '1010' && opts.bankLabel ? { ...r, name: opts.bankLabel } : r)
  return [...rows, ...equityRows(opts.constitution ?? 'PRIVATE_LIMITED')]
}

export async function seedAccounts(prisma: Db, companyId: string, opts: ChartOptions = {}) {
  const chart = chartFor(opts)
  // two passes so parents exist before children reference them
  for (const r of chart.filter((r) => !r.parent)) {
    await prisma.account.upsert({
      where: { companyId_code: { companyId, code: r.code } },
      update: { name: r.name, type: r.type, subType: r.subType },
      create: { companyId, code: r.code, name: r.name, type: r.type, subType: r.subType, isSystem: true },
    })
  }
  for (const r of chart.filter((r) => r.parent)) {
    const parent = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId, code: r.parent! } } })
    await prisma.account.upsert({
      where: { companyId_code: { companyId, code: r.code } },
      update: { name: r.name, type: r.type, subType: r.subType, parentId: parent.id },
      create: { companyId, code: r.code, name: r.name, type: r.type, subType: r.subType, parentId: parent.id, isSystem: true },
    })
  }
  return chart.length
}
