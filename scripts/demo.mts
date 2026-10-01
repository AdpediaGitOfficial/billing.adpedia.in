/** Creates one real invoice in the dev database so the document can be viewed. */
import { PrismaClient } from '@prisma/client'
import { createInvoice, sendInvoice } from '../src/server/services/invoicing/invoice'
import { createReceipt } from '../src/server/services/sales/receipt'

const prisma = new PrismaClient()
const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
const user = await prisma.user.findFirstOrThrow()
const ctx = { userId: user.id, companyId: company.id, role: 'OWNER' as const }

const customer = await prisma.customer.upsert({
  where: { id: (await prisma.customer.findFirst({ where: { companyId: company.id, name: 'Click AR Business Private Limited' } }))?.id ?? 'new' },
  update: {},
  create: {
    companyId: company.id, name: 'Click AR Business Private Limited',
    country: 'IN', stateCode: '32', gstin: '32AAKCC9890P1ZS', customerType: 'B2B',
    paymentTermDays: 15, defaultTdsSection: '194J',
    billingAddress: { line1: '36/3460-A, M G Road', city: 'Thrissur', state: 'Kerala', pincode: '680001', country: 'India' },
  },
})

const project = await prisma.project.upsert({
  where: { companyId_code: { companyId: company.id, code: 'PRIME-WEB' } },
  update: {},
  create: { companyId: company.id, customerId: customer.id, code: 'PRIME-WEB', name: 'Prime — Website Development', contractValue: '800000', status: 'ACTIVE' },
})

const draft = await createInvoice(ctx, {
  customerId: customer.id, projectId: project.id, date: '2026-09-30',
  customerRef: 'CLICK/PO/2026/14', milestone: '3 of 4', tdsSection: '194J',
  lines: [
    { description: 'Staff augmentation — software development resource', sacCode: '998314', quantity: '1', rate: '70000', gstRatePct: '18', detail: 'Milestone 3: front-end build & CMS integration. Period 01–30 Sep 2026.' },
    { description: 'UI/UX design revisions', sacCode: '998391', quantity: '2', rate: '7500', gstRatePct: '18', detail: 'Two additional revision rounds per change request CR-04.' },
  ],
})
const sent = await sendInvoice(ctx, draft.id)
console.log(`invoice ${sent.number}  total ${sent.grandTotal}  TDS ${sent.tdsAmount}  net ${sent.netPayable}`)
console.log(`document: http://localhost:3000/api/invoices/${sent.id}/document`)

await createReceipt(ctx, {
  customerId: customer.id, date: '2026-09-30', mode: 'NEFT', reference: 'NEFT/HDFCH00822263366',
  allocations: [{ invoiceId: sent.id, amount: '91800', tdsAmount: '8500' }],
})
console.log('receipt posted: ₹91,800 cash + ₹8,500 TDS -> invoice settled')


// ── phase 3: vendors, bills, reverse charge, expenses ───────────────────────
import { createVendor } from '../src/server/services/purchases/vendor'
import { createBill, approveBill, payBill } from '../src/server/services/purchases/bill'
import { createExpense } from '../src/server/services/purchases/expense'

const vendors = {
  akash: await createVendor(ctx, { name: 'Akash Raveendran', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', pan: 'ABCPD1234E', defaultTdsSection: '194J' }),
  praveen: await createVendor(ctx, { name: 'Praveen C D', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', pan: 'ABCPE5678F', defaultTdsSection: '194J' }),
  maneesh: await createVendor(ctx, { name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32', defaultTdsSection: '194J' }),
  exalture: await createVendor(ctx, { name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32', gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C' }),
  digitalOcean: await createVendor(ctx, { name: 'DigitalOcean LLC', vendorType: 'CLOUD', country: 'US' }),
  blueLight: await createVendor(ctx, { name: 'Blue Light Cable Vision', vendorType: 'UTILITY', country: 'IN', stateCode: '32', gstin: '32AABCB9999B1Z9' }),
}
console.log(`vendors: ${Object.keys(vendors).length} created`)

const bill = (vendorId: string, number: string, date: string, rate: string, account: string, desc: string) =>
  createBill(ctx, { vendorId, billNumber: number, billDate: date, lines: [{ description: desc, sacCode: '998314', quantity: '1', rate, gstRatePct: '18', expenseAccountCode: account }] })

// Praveen: two bills under the limit, the third crosses it
const p1 = await bill(vendors.praveen.id, 'PCD/001', '2026-07-12', '8500', '5210', 'Front-end fixes')
await approveBill(ctx, p1.id)
const p2 = await bill(vendors.praveen.id, 'PCD/002', '2026-08-18', '10000', '5210', 'API integration')
await approveBill(ctx, p2.id)
const p3 = await bill(vendors.praveen.id, 'PCD/003', '2026-09-20', '40000', '5210', 'Dashboard build')
const crossed = await approveBill(ctx, p3.id)
console.log(`Praveen crossing: bill 3 TDS ${crossed.tdsAmount} on a cumulative base (not just this bill)`)

const ex = await bill(vendors.exalture.id, 'EX/2026/114', '2026-09-08', '200000', '5220', 'Backend development — milestone 2')
await approveBill(ctx, ex.id)
await payBill(ctx, { billId: ex.id, date: '2026-09-25', amount: '232000', mode: 'NEFT', reference: 'NEFT/AXODH18223' })

const ak = await bill(vendors.akash.id, 'AK/0926', '2026-09-10', '80000', '5210', 'Full-stack development — September')
await approveBill(ctx, ak.id)

const doBill = await createBill(ctx, {
  vendorId: vendors.digitalOcean.id, billNumber: 'DO-2026-09', billDate: '2026-09-01',
  lines: [{ description: 'Droplets and managed Postgres', quantity: '1', rate: '25000', expenseAccountCode: '5310' }],
})
const doApproved = await approveBill(ctx, doBill.id)
console.log(`DigitalOcean: self-invoice ${doApproved.selfInvoiceNo}, RCM IGST ${doApproved.rcmIgst} payable in cash and claimable as ITC`)

const mu = await bill(vendors.maneesh.id, 'MU/0926', '2026-09-15', '20000', '5210', 'Logo design')
await approveBill(ctx, mu.id)
console.log(`Maneesh (no PAN): TDS ${(await prisma.vendorBill.findUniqueOrThrow({ where: { id: mu.id } })).tdsAmount} at 20% under s.206AA`)

const cats = Object.fromEntries((await prisma.expenseCategory.findMany({ where: { companyId: company.id } })).map((c) => [c.code, c.id]))
await createExpense(ctx, { categoryId: cats.INTERNET, date: '2026-09-05', description: 'Blue Light Cable Vision — September', taxableValue: '2000', vendorId: vendors.blueLight.id })
await createExpense(ctx, { categoryId: cats.TRAVEL, date: '2026-09-12', description: 'Client dinner — Thrissur', taxableValue: '4000', gstRatePct: '5', itcEligible: false, itcBlockedReason: 'S17_5_B_FOOD' })
await createExpense(ctx, { categoryId: cats.OFFICE, date: '2026-09-18', description: 'Office stationery', taxableValue: '3200' })
console.log('expenses: 3 recorded, one with blocked input credit')


// ── phase 4: payroll, allocation, project margin ────────────────────────────
import { setAnnualTaxEstimate } from '../src/server/services/payroll/tds-192'
import { setAllocation } from '../src/server/services/payroll/allocation'
import { approvePayroll, paySalaries } from '../src/server/services/payroll/run'

const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })
const emp = Object.fromEntries((await prisma.employee.findMany({ where: { companyId: company.id } })).map((e) => [e.employeeCode, e]))

const nuveClient = await prisma.customer.create({
  data: {
    companyId: company.id, name: 'Nuvé Properties Pvt Ltd', country: 'IN', stateCode: '27',
    gstin: '27AABCN1234M1Z5', tan: 'MUMN54321B', customerType: 'B2B',
    billingAddress: { line1: 'Unit 704, Lotus Corporate Park', city: 'Mumbai', state: 'Maharashtra', pincode: '400063', country: 'India' },
    paymentTermDays: 15, defaultTdsSection: '194C',
  },
})

const nuve = await prisma.project.upsert({
  where: { companyId_code: { companyId: company.id, code: 'NUVE' } },
  update: {},
  // the Nuvé project belongs to the Nuvé client — pointing it at Click AR made client P&L
  // attribute Nuvé's cost to the wrong customer
  create: { companyId: company.id, customerId: nuveClient.id, code: 'NUVE', name: 'Nuvé — Brand Film', contractValue: '400000', status: 'ACTIVE' },
})

// the CA's annual estimates
await setAnnualTaxEstimate({ companyId: company.id, employeeId: emp['ADP-001'].id, financialYearId: fy.id, estimatedAnnualTax: '560000', source: 'CA estimate, Apr 2026' })
await setAnnualTaxEstimate({ companyId: company.id, employeeId: emp['ADP-002'].id, financialYearId: fy.id, estimatedAnnualTax: '48000', source: 'CA estimate, Apr 2026' })
await setAnnualTaxEstimate({ companyId: company.id, employeeId: emp['ADP-003'].id, financialYearId: fy.id, estimatedAnnualTax: '12000', source: 'CA estimate, Apr 2026' })
// ADP-004 deliberately left without one, so the warning is visible

const period = { periodFrom: '2026-04-01', periodTo: '2027-03-31' }
await setAllocation(ctx, { employeeId: emp['ADP-002'].id, ...period, splits: [{ projectId: project.id, percent: '60' }, { projectId: nuve.id, percent: '30' }, { projectId: null, percent: '10' }] })
await setAllocation(ctx, { employeeId: emp['ADP-003'].id, ...period, splits: [{ projectId: project.id, percent: '80' }, { projectId: null, percent: '20' }] })
await setAllocation(ctx, { employeeId: emp['ADP-004'].id, ...period, splits: [{ projectId: nuve.id, percent: '70' }, { projectId: null, percent: '30' }] })
await setAllocation(ctx, { employeeId: emp['ADP-001'].id, ...period, splits: [{ projectId: null, percent: '100' }] })

for (const m of [7, 8, 9]) {
  const run = await approvePayroll(ctx, m, 2026)
  await paySalaries(ctx, run.id, `2026-${String(m + 1).padStart(2, '0')}-02`)
}
const sep = await prisma.payrollRun.findFirstOrThrow({ where: { companyId: company.id, month: 9, year: 2026 } })
console.log(`payroll: Jul–Sep run · Sep gross ${sep.grossTotal} · TDS ${sep.tdsTotal} · net ${sep.netTotal}`)

const pnl = await (await import('../src/server/services/reports/project-pnl')).projectPnl(ctx, fy.id)
for (const r of pnl) {
  console.log(`  ${r.name.padEnd(26)} revenue ${String(r.revenue).padStart(8)} · staff ${String(r.staffCost).padStart(7)} · margin ${r.marginPct ? r.marginPct.toFixed(1) + '%' : '—'}`)
}


// ── phase 6: TDS receivable and the 26AS gap ────────────────────────────────
import { import26as, reconcile26as } from '../src/server/services/tax/form26as'

await prisma.customer.update({ where: { id: customer.id }, data: { tan: 'TVDC12345E' } })

const d2 = await createInvoice(ctx, {
  customerId: nuveClient.id, projectId: nuve.id, date: '2026-08-14', tdsSection: '194C',
  // 999612 — motion picture / video production. Billing a film under 998314 (IT design &
  // development) misstates the supply in the GSTR-1 HSN summary, not just on the invoice.
  lines: [{ description: 'Brand film — milestone 1', sacCode: '999612', quantity: '1', rate: '200000', gstRatePct: '18' }],
})
const inv2 = await sendInvoice(ctx, d2.id)
await createReceipt(ctx, { customerId: nuveClient.id, date: '2026-08-28', mode: 'NEFT', reference: 'NEFT/NUVE/0814', allocations: [{ invoiceId: inv2.id, amount: '232000', tdsAmount: '4000' }] })

// 26AS carries Click AR but NOT Nuvé, plus a credit with nothing behind it
await import26as(ctx, `
Sr,Name of Deductor,TAN,Section,Transaction Date,Status,Amount Paid,Tax Deducted
1,CLICK AR BUSINESS PRIVATE LIMITED,TVDC12345E,194J,30-Sep-2026,F,85000.00,8500.00
2,KAYLA MAYOTECH LLP,CHNK77777K,194J,12-Sep-2026,F,60000.00,6000.00
`.trim(), fy.id)
const recon = await reconcile26as(ctx, fy.id)
console.log(`26AS: ${recon.matched.length} matched · ${recon.missingIn26as.length} missing from 26AS (₹${recon.totals.missingAmount}) · ${recon.notInBooks.length} in 26AS with nothing in the books (₹${recon.totals.extraAmount})`)


// ── phase 7: a bank statement to reconcile ──────────────────────────────────
import { importStatement } from '../src/server/services/banking/import'
import { reconciliationQueue } from '../src/server/services/banking/reconcile'

// An invoice left OPEN, so the statement has something to settle against.
const d3 = await createInvoice(ctx, {
  customerId: customer.id, projectId: project.id, date: '2026-09-28',
  customerRef: 'CLICK/PO/2026/15', milestone: '4 of 4', tdsSection: '194J',
  lines: [{ description: 'Staff augmentation — software development resource', sacCode: '998314', quantity: '1', rate: '120000', gstRatePct: '18', detail: 'Milestone 4: launch support. Period 01–30 Sep 2026.' }],
})
const open3 = await sendInvoice(ctx, d3.id)
console.log(`open invoice ${open3.number}  total ${open3.grandTotal}  TDS ${open3.tdsAmount}  net ${open3.netPayable}`)

const bankAcct = await prisma.companyBankAccount.findFirstOrThrow({ where: { companyId: company.id, isDefault: true } })

// Five lines, each exercising a different tier. Amounts are derived from the
// documents above: the client pays net of TDS, the vendors are paid net of TDS.
const stmt = `
Statement of Axis Bank Account No : 921020015185413
Opening Balance: INR 47306.25

Transaction Date,Value Date,Particulars,Cheque Number,Amount(INR),Debit/Credit,Balance(INR),Branch Name(SOL)
05/10/2026,05/10/2026,NEFT/HDFCH00822263366/CLICK AR BUSINESS PRIVATE LI/HDFC BANK/0001NBBKYH4PQNM6W3RM,,129600.00,CR,176906.25,CHALAKUDY CHAL KL (248)
06/10/2026,06/10/2026,IMPS/P2A/605108713778/PRAVEEN C D/X111100/HDFCBANKLTD/Vendor,,34150.00,DR,142756.25,CHALAKUDY CHAL KL (2174)
07/10/2026,07/10/2026,INB/NEFT/AXODH18223456789/AKASH RAVEENDRAN/ICICI BANK//////,,72000.00,DR,70756.25,CHALAKUDY CHAL KL (2174)
08/10/2026,08/10/2026,Monthly Service Chrgs,,100.00,DR,70656.25,CHALAKUDY CHAL KL (2174)
08/10/2026,08/10/2026,GST @18% on Monthly Service Chrgs,,18.00,DR,70638.25,CHALAKUDY CHAL KL (2174)

Closing Balance: INR 70638.25
`.trim()

const imp = await importStatement(ctx, { bankAccountId: bankAcct.id, profileKey: 'AXIS', text: stmt, fileName: 'axis-oct-2026.csv' })
console.log(`statement: ${imp.imported} lines imported · balance check ${imp.balanceCheck.ok ? 'passed' : 'FAILED'}`)

for (const q of await reconciliationQueue(ctx, bankAcct.id)) {
  const top = q.suggestions[0]
  const amt = `${q.txn.direction === 'CREDIT' ? '+' : '-'}${q.txn.amount}`
  console.log(`  ${amt.padStart(11)}  ${top ? `[${top.confidence}%] ${top.tierName} — ${top.reason}` : 'no suggestion — needs a human'}`)
}

await prisma.$disconnect()
