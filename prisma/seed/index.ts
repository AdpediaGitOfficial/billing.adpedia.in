import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../src/server/auth/password'
import { seedAccounts } from './accounts'
import { seedTdsRates, seedExpenseCategories } from './tax-rates'
import { seedProfessionTax, seedEmployees } from './payroll'
import { renderPattern, validateInvoiceNumber } from '../../src/server/services/invoicing/numbering'
import { shortFy } from '../../src/lib/fy'
import { SEED_RULES } from '../../src/server/services/banking/match'


// ── Adpedia, verified from the PAN card, GST REG-06 and MCA incorporation certificate ──
const ADPEDIA = {
  legalName: 'ADPEDIA FILMS PRIVATE LIMITED',
  tradeName: 'ADPEDIA FILMS PRIVATE LIMITED',
  cin: 'U92190KL2021PTC068241',
  pan: 'AAUCA9985H',
  tan: 'CHNA09808A',            // ⚠️ verify — partly clipped in the source PDF
  gstin: '32AAUCA9985H1ZX',
  stateCode: '32',              // Kerala — drives CGST+SGST vs IGST
  registeredAddress: {
    line1: 'VIII/318, Chinnangath House',
    line2: 'Thommana, Kaduppassery P.O., Irinjalakuda',
    city: 'Thrissur', state: 'Kerala', stateCode: '32',
    pincode: '680683', country: 'India',
  },
}

export interface SeedOptions { quiet?: boolean; ownerEmail?: string; ownerPassword?: string }

/** Callable so integration tests can reset to a known state. */
export async function seedAll(prisma: PrismaClient, opts: SeedOptions = {}) {
  const log = opts.quiet ? () => {} : console.log
  log('seeding Adpedia Finance ERP\n')

  const company = await prisma.company.upsert({
    where: { pan_gstin: { pan: ADPEDIA.pan, gstin: ADPEDIA.gstin } },
    update: {},
    create: {
      legalName: ADPEDIA.legalName,
      tradeName: ADPEDIA.tradeName,
      constitution: 'PRIVATE_LIMITED',
      cin: ADPEDIA.cin,
      pan: ADPEDIA.pan,
      tan: ADPEDIA.tan,
      gstin: ADPEDIA.gstin,
      gstRegistrationType: 'REGULAR',
      gstRegisteredFrom: new Date(Date.UTC(2021, 10, 11)),   // 11 Nov 2021
      incorporatedOn: new Date(Date.UTC(2021, 2, 23)),       // 23 Mar 2021
      stateCode: ADPEDIA.stateCode,
      registeredAddress: ADPEDIA.registeredAddress,
      currencyDefault: 'INR',
      fyStartMonth: 4,
      defaultPaymentDays: 15,
      showSacOnInvoice: false,        // docs/03 §7.2 — client's choice, pending CA input
      brandPrimaryHex: '#4135AF',
      brandFont: 'Poppins',
      logoUrl: '/brand/adpedia-logo.svg',
      signatureImageUrl: '/brand/signature.png',
    },
  })
  log(`  company      ${company.legalName}`)

  // ── financial years ──
  const fys = [
    { label: '2025-26', startsOn: new Date(Date.UTC(2025, 3, 1)), endsOn: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)), status: 'CLOSED' as const },
    { label: '2026-27', startsOn: new Date(Date.UTC(2026, 3, 1)), endsOn: new Date(Date.UTC(2027, 2, 31, 23, 59, 59)), status: 'OPEN' as const },
  ]
  for (const fy of fys) {
    await prisma.financialYear.upsert({
      where: { companyId_label: { companyId: company.id, label: fy.label } },
      update: {}, create: { companyId: company.id, ...fy },
    })
  }
  const currentFy = await prisma.financialYear.findUniqueOrThrow({
    where: { companyId_label: { companyId: company.id, label: '2026-27' } },
  })
  log(`  fin. years   ${fys.map((f) => f.label).join(', ')}  (current ${currentFy.label})`)

  // ── invoice series: continues the existing count, adopts the FY-prefixed format ──
  await prisma.documentSeries.upsert({
    where: { companyId_financialYearId_docType: { companyId: company.id, financialYearId: currentFy.id, docType: 'TAX_INVOICE' } },
    update: {},
    create: {
      companyId: company.id, financialYearId: currentFy.id, docType: 'TAX_INVOICE',
      prefix: 'ADP', pattern: 'ADP/{FY}/{SEQ:4}', nextSeq: 26,   // confirmed with client
    },
  })
  // Rule 46 caps a document number at 16 characters. 'ADP/EXP/{FY}/{SEQ:4}' renders
  // as ADP/EXP/26-27/0004 = 18, which is non-compliant — hence the 4-char prefixes.
  for (const [docType, pattern] of [
    ['EXPORT_INVOICE', 'ADPX/{FY}/{SEQ:4}'],   // ADPX/26-27/0004  (15)
    ['CREDIT_NOTE', 'ADPC/{FY}/{SEQ:4}'],      // ADPC/26-27/0001  (15)
    ['DEBIT_NOTE', 'ADPD/{FY}/{SEQ:4}'],       // ADPD/26-27/0001  (15) — docs/53
    ['RECEIPT', 'ADPR/{FY}/{SEQ:4}'],
    ['SELF_INVOICE', 'ADPS/{FY}/{SEQ:4}'],
    ['PROFORMA', 'ADPP/{FY}/{SEQ:4}'],
    ['REFUND_VOUCHER', 'ADPF/{FY}/{SEQ:4}'],   // ADPF/26-27/0001  (15) — docs/65
  ] as const) {
    await prisma.documentSeries.upsert({
      where: { companyId_financialYearId_docType: { companyId: company.id, financialYearId: currentFy.id, docType } },
      update: {},
      create: { companyId: company.id, financialYearId: currentFy.id, docType, prefix: 'ADP', pattern, nextSeq: 1 },
    })
  }
  // every series must render a Rule 46-compliant number
  for (const series of await prisma.documentSeries.findMany({ where: { companyId: company.id, financialYearId: currentFy.id } })) {
    const sample = renderPattern(series.pattern, { FY: shortFy(currentFy.label), SEQ: 9999 })
    const check = validateInvoiceNumber(sample)
    if (!check.ok) throw new Error(`Series ${series.docType}: ${check.reason}`)
  }
  log('  series       ADP/26-27/0026 next, + ADPX / ADPC / ADPD / ADPR / ADPS / ADPP / ADPF  (all Rule 46 compliant)')

  // ── chart of accounts ──
  const nAccounts = await seedAccounts(prisma, company.id)
  log(`  accounts     ${nAccounts} ledger accounts`)

  // ── bank account, mapped to GL 1010 ──
  const bankGl = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId: company.id, code: '1010' } } })
  await prisma.companyBankAccount.upsert({
    where: { companyId_accountNo: { companyId: company.id, accountNo: '921020015185413' } },
    update: {},
    create: {
      companyId: company.id, label: 'Axis Bank — Current',
      accountName: ADPEDIA.legalName, accountNo: '921020015185413',
      ifsc: 'UTIB0002174', micr: '680211006',
      bankName: 'Axis Bank Ltd', branch: 'Chalakudy (CHAL KL)',
      currency: 'INR', ledgerAccountId: bankGl.id, showOnInvoice: true, isDefault: true,
    },
  })
  log('  bank         Axis 921020015185413 -> GL 1010')

  // ── starter bank rules. These four narrations are the BANK's own wording, identical
  // on every Axis account, so there is nothing company-specific to learn: a charge is a
  // charge. Everything else the matcher learns from the user (docs/02 §H5).
  for (const r of SEED_RULES) {
    const existing = await prisma.bankRule.findFirst({
      where: { companyId: company.id, pattern: r.pattern, direction: r.direction },
    })
    if (existing) continue
    await prisma.bankRule.create({
      data: {
        companyId: company.id, pattern: r.pattern, matchType: r.matchType,
        direction: r.direction, accountCode: r.accountCode, label: r.label,
        customerId: r.customerId, vendorId: r.vendorId, employeeId: r.employeeId,
        autoApply: r.autoApply, confirmCount: 0,
      },
    })
  }
  log(`  bank rules   ${SEED_RULES.length} starter rules (charges, GST on charges, interest)`)

  // ── service catalogue, so a SAC is chosen from a list rather than typed from memory ──
  const SERVICES: { name: string; sac: string; rate?: string; account: string }[] = [
    { name: 'Brand film — production',        sac: '999612', account: '4040' },
    { name: 'Ad film / TVC — production',     sac: '999612', account: '4040' },
    { name: 'Post-production — edit & grade', sac: '999613', account: '4040' },
    { name: 'Motion graphics & animation',    sac: '999613', account: '4040' },
    { name: 'Voice-over & sound mix',         sac: '999611', account: '4040' },
    { name: 'Campaign creative',              sac: '998361', account: '4030' },
    { name: 'Event videography',              sac: '998383', account: '4040' },
    { name: 'Website development',            sac: '998314', rate: '0', account: '4010' },
    { name: 'Staff augmentation',             sac: '998314', account: '4020' },
    { name: 'UI/UX design',                   sac: '998391', account: '4030' },
  ]
  for (const sv of SERVICES) {
    const acc = await prisma.account.findUnique({ where: { companyId_code: { companyId: company.id, code: sv.account } } })
    const existing = await prisma.serviceItem.findFirst({ where: { companyId: company.id, name: sv.name } })
    if (existing) continue
    await prisma.serviceItem.create({
      data: { companyId: company.id, name: sv.name, sacCode: sv.sac, gstRatePct: '18', incomeAccountId: acc?.id },
    })
  }
  log(`  services     ${SERVICES.length} items  (film 999612/999613, IT 998314, design 998391)`)

  // ── LUT register. FY 2026-27 is MISSING — exports are blocked until it is filed. ──
  const luts = [
    { arn: 'AD320324005917B', fyLabel: '2024-25', filedOn: new Date(Date.UTC(2024, 2, 18)) },
    { arn: 'AD320325043063O', fyLabel: '2025-26', filedOn: new Date(Date.UTC(2025, 2, 1)) },
  ]
  for (const l of luts) {
    const start = Number(l.fyLabel.split('-')[0])
    await prisma.companyLut.upsert({
      where: { companyId_fyLabel: { companyId: company.id, fyLabel: l.fyLabel } },
      update: {},
      create: {
        companyId: company.id, arn: l.arn, filedOn: l.filedOn, fyLabel: l.fyLabel,
        validFrom: new Date(Date.UTC(start, 3, 1)), validTo: new Date(Date.UTC(start + 1, 2, 31, 23, 59, 59)),
      },
    })
  }
  log('  LUTs         2024-25, 2025-26  ⚠️  FY 2026-27 NOT ON FILE — exports blocked')

  // ── tax config ──
  log(`  TDS rates    ${await seedTdsRates(prisma)} sections  ⚠️ statutory as at 01 Apr 2025 — CA to sign off, recheck vs Finance Act 2026`)
  log(`  expense cat. ${await seedExpenseCategories(prisma, company.id)} categories`)
  log(`  prof. tax    ${await seedProfessionTax(prisma, ADPEDIA.stateCode)} Kerala slabs  ⚠️ caps at ₹2,500/yr per Art. 276(2) — confirm Chalakudy's notification`)
  log(`  employees    ${await seedEmployees(prisma, company.id)} on payroll (1 director + 3 staff)`)

  // ── first user ──
  const email = opts.ownerEmail ?? process.env.SEED_OWNER_EMAIL ?? 'owner@adpedia.local'
  const password = opts.ownerPassword ?? process.env.SEED_OWNER_PASSWORD ?? 'ChangeMe!' + Math.random().toString(36).slice(2, 10)
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Adpedia Owner', passwordHash: await hashPassword(password) },
  })
  await prisma.userCompany.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    update: { role: 'OWNER' },
    create: { userId: user.id, companyId: company.id, role: 'OWNER' },
  })
  log(`\n  owner login  ${email}`)
  if (!process.env.SEED_OWNER_PASSWORD) console.log(`  password     ${password}   <- generated, change on first login`)

  log('\nseed complete.')
  return { company, currentFy }
}

// CLI entry — `npm run db:seed`
if (process.argv[1]?.includes('seed')) {
  const prisma = new PrismaClient()
  seedAll(prisma)
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => prisma.$disconnect())
}
