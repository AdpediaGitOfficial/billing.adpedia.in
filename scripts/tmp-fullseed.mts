import { PrismaClient } from '@prisma/client'
import { createCustomer } from '../src/server/services/sales/customer'
import { createInvoice, sendInvoice, cancelInvoice } from '../src/server/services/invoicing/invoice'
import { createCreditNote } from '../src/server/services/invoicing/credit-note'
import { createDebitNote } from '../src/server/services/invoicing/debit-note'
import { createReceipt } from '../src/server/services/sales/receipt'
import { createAdvanceReceipt } from '../src/server/services/sales/advance'
import { createRefundVoucher } from '../src/server/services/sales/refund'
import { createVendor } from '../src/server/services/purchases/vendor'
import { createBill, approveBill, payBill } from '../src/server/services/purchases/bill'
import { createExpense } from '../src/server/services/purchases/expense'
import { setTaxEstimate, recordAdvanceTax } from '../src/server/services/tax/advance-tax'
import { recordRocDates } from '../src/server/services/compliance/roc'
import { createInvitation } from '../src/server/services/auth/invitation'
import { closePdfBrowser } from '../src/server/services/invoicing/pdf'

const prisma = new PrismaClient()
const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
const user = await prisma.user.findFirstOrThrow()
const ctx = { userId: user.id, companyId: company.id, role: 'OWNER' as const }
const log = (s: string) => console.log('SEED ' + s)

const kerala = await createCustomer(ctx, {
  name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32', gstin: '32AAKCC9890P1ZS',
  customerType: 'B2B', paymentTermDays: 15, defaultTdsSection: '194J',
  billingAddress: { line1: 'Kakkanad', city: 'Ernakulam', pincode: '682030', state: 'Kerala' },
})
const tn = await createCustomer(ctx, {
  name: 'Madras Media Works', country: 'IN', stateCode: '33', gstin: '33AAKCC9890P1ZT',
  customerType: 'B2B', paymentTermDays: 30,
  billingAddress: { line1: 'Adyar', city: 'Chennai', pincode: '600020', state: 'Tamil Nadu' },
})
const us = await createCustomer(ctx, {
  name: 'Northfield Studios LLC', country: 'US', customerType: 'B2B', paymentTermDays: 30,
  billingAddress: { line1: '400 Market St', city: 'Austin', country: 'US' },
})
log('customers')

// test-database only: the real FY 2026-27 LUT is one of docs/00 §1's blockers
await prisma.companyLut.upsert({
  where: { companyId_fyLabel: { companyId: company.id, fyLabel: '2026-27' } },
  update: {},
  create: {
    companyId: company.id, arn: 'AD320426099999Z', fyLabel: '2026-27',
    filedOn: new Date('2026-03-20'),
    validFrom: new Date('2026-04-01'), validTo: new Date('2027-03-31T23:59:59Z'),
  },
})

const project = await prisma.project.create({
  data: { companyId: company.id, customerId: kerala.id, code: 'PRIME-WEB', name: 'Prime — Website', status: 'ACTIVE' },
})

async function inv(customerId: string, date: string, rate: string, opts: { send?: boolean; tds?: '194J' | null } = {}) {
  const i = await createInvoice(ctx, {
    customerId, projectId: customerId === kerala.id ? project.id : undefined, date,
    tdsSection: opts.tds ?? null,
    lines: [{ description: 'Staff augmentation', sacCode: '998314', rate, quantity: '1', gstRatePct: '18' }],
  })
  return opts.send === false ? i : sendInvoice(ctx, i.id)
}

const a = await inv(kerala.id, '2026-05-10', '400000', { tds: '194J' })
const b = await inv(kerala.id, '2026-06-02', '250000', { tds: '194J' })
const c = await inv(tn.id, '2026-06-20', '180000')
const d = await inv(us.id, '2026-07-05', '9000')
await inv(kerala.id, '2026-09-01', '75000', { send: false })
const e = await inv(kerala.id, '2026-04-02', '120000')
await cancelInvoice(ctx, e.id, 'Raised against the wrong customer')
log('invoices')

await createCreditNote(ctx, { invoiceId: a.id, date: '2026-06-15', reason: 'Two days of the shoot were not delivered', taxableValue: '50000' })
await createDebitNote(ctx, { invoiceId: b.id, date: '2026-07-02', reason: 'Extra shoot day agreed after the invoice went out', taxableValue: '40000' })
log('notes')

await createReceipt(ctx, {
  customerId: kerala.id, date: '2026-07-20', mode: 'NEFT', reference: 'UTR9912',
  allocations: [{ invoiceId: a.id, amount: '385200', tdsAmount: '40000' }],
})
const adv = await createAdvanceReceipt(ctx, {
  customerId: tn.id, date: '2026-05-05', amount: '118000', mode: 'NEFT', gstRatePct: '18',
  description: 'Advance for the Nuvé brand film',
})
await createRefundVoucher(ctx, { receiptId: adv.id, date: '2026-06-20', amount: '59000', reason: 'Half the scope was dropped by the client' })
log('receipts')

const vIn = await createVendor(ctx, {
  name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
  gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
})
const vNoGst = await createVendor(ctx, { name: 'Thrissur Lorry Service', vendorType: 'OTHER', country: 'IN', stateCode: '32' })
const vUs = await createVendor(ctx, { name: 'DigitalOcean LLC', vendorType: 'OTHER', country: 'US' })

const bill1 = await createBill(ctx, {
  vendorId: vIn.id, billNumber: 'EX/300', billDate: '2026-06-10',
  lines: [{ description: 'Front-end build', rate: '150000', gstRatePct: '18', expenseAccountCode: '5210' }],
})
await approveBill(ctx, bill1.id)
await payBill(ctx, { billId: bill1.id, amount: '162000', date: '2026-07-01', mode: 'NEFT', reference: 'UTR771' })
await createBill(ctx, {
  vendorId: vIn.id, billNumber: 'EX/301', billDate: '2026-08-14',
  lines: [{ description: 'Maintenance retainer', rate: '60000', gstRatePct: '18', expenseAccountCode: '5210' }],
})
const bill3 = await createBill(ctx, {
  vendorId: vUs.id, billNumber: 'DO/9912', billDate: '2026-07-15',
  lines: [{ description: 'Droplets and storage', rate: '18000', gstRatePct: '18', expenseAccountCode: '5310' }],
})
await approveBill(ctx, bill3.id)
await createBill(ctx, {
  vendorId: vNoGst.id, billNumber: 'TLS/41', billDate: '2026-08-20',
  lines: [{ description: 'Equipment move to location', rate: '20000', gstRatePct: '18', expenseAccountCode: '5300' }],
})
log('bills')

const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: company.id } })
for (let i = 0; i < 8; i++) {
  await createExpense(ctx, {
    categoryId: cat.id, date: `2026-0${(i % 4) + 5}-1${i}`, description: `Studio consumables ${i + 1}`,
    taxableValue: String(2500 + i * 300), gstRatePct: '18', gstMode: 'INTRA', paidFrom: 'BANK',
  })
}
log('expenses')

const fy = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2026-27' } })
await setTaxEstimate(ctx, { financialYearId: fy.id, estimatedAnnualTax: '840000', source: 'R Menon & Co, interim after Q2' })
await recordAdvanceTax(ctx, { paidOn: '2026-06-12', amount: '110000', bsrCode: '0510308', challanSerial: '00011' })
await recordAdvanceTax(ctx, { paidOn: '2026-09-14', amount: '160000', bsrCode: '0510308', challanSerial: '00012' })

const prev = await prisma.financialYear.findFirstOrThrow({ where: { companyId: company.id, label: '2025-26' } })
await recordRocDates(ctx, { financialYearId: prev.id, agmHeldOn: '2026-08-15', agmSource: 'Minutes of the meeting, signed' })
await createInvitation(ctx, { email: 'priya@example.com', name: 'Priya Nair', role: 'ACCOUNTANT' })
log('tax, roc, invitation')

console.log('SEED done', {
  invoices: await prisma.invoice.count(), bills: await prisma.vendorBill.count(),
  notes: await prisma.creditNote.count(), receipts: await prisma.receipt.count(),
  expenses: await prisma.expense.count(), entries: await prisma.journalEntry.count(),
})
await closePdfBrowser()
await prisma.$disconnect()
