import { prisma } from '@/server/db'
import { Decimal, ZERO, round2 } from '@/lib/money'
import { fyQuarter } from '@/lib/fy'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { assertPostable } from '@/server/services/accounting/period'
import { postJournal, reverseJournal } from '@/server/services/accounting/journal'
import { postVendorBill, postTdsDeduction, postRcmSelfInvoice, postBillPayment } from '@/server/services/accounting/rules/purchase'
import { allocateNumber } from '@/server/services/invoicing/numbering'
import { resolveTds, cumulativeThisFy, type TdsDecision } from '@/server/services/tax/tds-resolver'

const RCM_RATE = new Decimal(18)   // import of services

export interface BillLineInput {
  description: string
  sacCode?: string
  quantity?: string
  rate: string
  gstRatePct?: string
  expenseAccountCode: string
}

export interface BillInput {
  vendorId: string
  projectId?: string
  billNumber: string
  billDate: string
  dueDate?: string
  tdsSection?: string | null
  itcEligible?: boolean
  itcBlockedReason?: string
  lines: BillLineInput[]
}

export interface BillPreview {
  vendor: { id: string; name: string; isForeignSupplier: boolean; rcmApplicable: boolean; pan: string | null; panVerified: boolean }
  taxableValue: Decimal
  cgst: Decimal; sgst: Decimal; igst: Decimal
  grandTotal: Decimal
  rcmIgst: Decimal
  tds: TdsDecision
  netPayable: Decimal
  itcEligible: boolean
  warnings: string[]
}

/** Intra-state purchases carry CGST+SGST, inter-state IGST, foreign none (RCM instead). */
function splitGst(taxable: Decimal, ratePct: Decimal, mode: 'INTRA' | 'INTER' | 'NONE') {
  if (mode === 'NONE') return { cgst: ZERO, sgst: ZERO, igst: ZERO }
  const tax = round2(taxable.mul(ratePct).div(100))
  if (mode === 'INTER') return { cgst: ZERO, sgst: ZERO, igst: tax }
  const cgst = round2(tax.div(2))
  return { cgst, sgst: round2(tax.minus(cgst)), igst: ZERO }
}

export async function previewBill(ctx: RequestContext, input: BillInput, excludeBillId?: string): Promise<BillPreview> {
  const [company, vendor] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
    prisma.vendor.findFirst({ where: { id: input.vendorId, companyId: ctx.companyId } }),
  ])
  if (!vendor) throw new NotFound('Vendor not found')

  const billDate = new Date(input.billDate)
  const fy = await assertPostable(ctx.companyId, billDate)
  const warnings: string[] = []

  const mode: 'INTRA' | 'INTER' | 'NONE' = vendor.country !== 'IN' || !vendor.gstin
    ? 'NONE'
    : vendor.stateCode === company.stateCode ? 'INTRA' : 'INTER'

  let taxableValue = ZERO, cgst = ZERO, sgst = ZERO, igst = ZERO
  for (const l of input.lines) {
    const base = round2(new Decimal(l.rate).mul(new Decimal(l.quantity ?? '1')))
    const g = splitGst(base, new Decimal(l.gstRatePct ?? '18'), mode)
    taxableValue = taxableValue.plus(base)
    cgst = cgst.plus(g.cgst); sgst = sgst.plus(g.sgst); igst = igst.plus(g.igst)
  }
  const grandTotal = taxableValue.plus(cgst).plus(sgst).plus(igst)

  // 🔴 reverse charge — the supplier charges nothing, Adpedia self-accounts IGST
  const rcmIgst = vendor.rcmApplicable ? round2(taxableValue.mul(RCM_RATE).div(100)) : ZERO
  if (vendor.rcmApplicable) {
    warnings.push(
      `${vendor.name} has no Indian GSTIN, so this is an import of service. IGST of ${rcmIgst.toFixed(2)} is payable under reverse charge — in cash, never set off against existing ITC — and a self-invoice will be generated under s.31(3)(f). The same amount is claimable as input credit in the period.`,
    )
  }

  /**
   * 🔴 GST was asked for and none arose — docs/79.
   *
   * An Indian supplier with no GSTIN is `mode: 'NONE'`, so `splitGst` returns zero whatever
   * rate the line carries. That is right in law and it is **silent**: somebody types 18%, the
   * total comes out at the bare amount, and nothing says the tax was dropped rather than
   * computed. This is also the one place a domestic reverse charge would surface, because the
   * person entering it is the person who expected tax.
   *
   * 🔴 It fires on the rate, not on the result. "No GST on this bill" is the normal state for
   * every unregistered vendor Adpedia uses, and warning on all of them is how a warning gets
   * ignored — `docs/60 §3`. Warning only where somebody expected tax is the targeted version
   * of the same question.
   *
   * What it does NOT do is decide whether s.9(3) applies. `docs/63 §3` is clear that nothing
   * here can know, and `docs/79` is clear that nothing should guess: the system cannot account
   * for a CGST + SGST reverse charge at all, so the honest act is to name it and stop.
   */
  const rateWasAsked = input.lines.some((l) => new Decimal(l.gstRatePct ?? '18').gt(0))
  if (mode === 'NONE' && vendor.country === 'IN' && rateWasAsked && taxableValue.gt(0)) {
    warnings.push(
      `${vendor.name} has no GSTIN on file, so no GST arises on this bill and the rate on the lines has been ` +
      'ignored rather than applied. If this is one of the services notified under s.9(3) — goods transport, ' +
      'an advocate’s fee, sponsorship, security — the tax is still payable, by Adpedia, under reverse charge ' +
      'at CGST + SGST. This system cannot account for that: ask the CA before approving it.',
    )
  }

  const section = input.tdsSection ?? vendor.defaultTdsSection
  const cumulativeBefore = section
    ? await cumulativeThisFy(ctx.companyId, vendor.id, section, fy.id, excludeBillId)
    : ZERO

  const tds = await resolveTds({
    sectionCode: section,
    onDate: billDate,
    thisBillBase: taxableValue,
    deductee: {
      pan: vendor.pan, panVerified: vendor.panVerified,
      lowerDeductionRate: vendor.lowerDeductionRate ? new Decimal(vendor.lowerDeductionRate.toString()) : null,
      lowerDeductionValidTo: vendor.lowerDeductionValidTo,
      lowerDeductionCap: vendor.lowerDeductionCap ? new Decimal(vendor.lowerDeductionCap.toString()) : null,
      lowerDeductionCertNo: vendor.lowerDeductionCertNo,
    },
    cumulativeBefore,
  })
  if (tds.warning) warnings.push(tds.warning)

  if (vendor.country !== 'IN' && section === '195') {
    warnings.push(
      'Payments to a non-resident need Form 15CA, and Form 15CB from a chartered accountant, BEFORE the remittance is made. The treaty rate also requires a Tax Residency Certificate and Form 10F from the payee.',
    )
  }

  const itcEligible = input.itcEligible ?? (mode !== 'NONE')
  if (!itcEligible && (cgst.gt(0) || sgst.gt(0) || igst.gt(0))) {
    warnings.push('Input credit is blocked on this bill, so the GST becomes part of the cost rather than a recoverable asset.')
  }

  return {
    vendor: { id: vendor.id, name: vendor.name, isForeignSupplier: vendor.isForeignSupplier, rcmApplicable: vendor.rcmApplicable, pan: vendor.pan, panVerified: vendor.panVerified },
    taxableValue, cgst, sgst, igst, grandTotal, rcmIgst, tds,
    netPayable: grandTotal.minus(tds.tdsAmount),
    itcEligible, warnings,
  }
}

export async function createBill(ctx: RequestContext, input: BillInput) {
  assertCan(ctx.role, 'bills', 'write')
  if (input.lines.length === 0) throw new AppError('A bill needs at least one line')

  const p = await previewBill(ctx, input)
  const billDate = new Date(input.billDate)
  const fy = await assertPostable(ctx.companyId, billDate)
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: input.vendorId } })

  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : new Date(billDate.getTime() + vendor.paymentTermDays * 86_400_000)

  const existing = await prisma.vendorBill.findFirst({
    where: { companyId: ctx.companyId, vendorId: input.vendorId, billNumber: input.billNumber },
  })
  if (existing) throw new AppError(`${vendor.name} already has a bill numbered ${input.billNumber}`)

  const bill = await prisma.vendorBill.create({
    data: {
      companyId: ctx.companyId, financialYearId: fy.id,
      vendorId: input.vendorId, projectId: input.projectId,
      billNumber: input.billNumber, billDate, dueDate,
      taxableValue: p.taxableValue.toFixed(2),
      cgst: p.cgst.toFixed(2), sgst: p.sgst.toFixed(2), igst: p.igst.toFixed(2),
      grandTotal: p.grandTotal.toFixed(2),
      isRcm: p.rcmIgst.gt(0), rcmIgst: p.rcmIgst.toFixed(2),
      itcEligible: p.itcEligible, itcBlockedReason: input.itcBlockedReason,
      // the section is stored even when nothing is deducted — a bill below the
      // threshold still counts toward it, and the cumulative lookup reads this column
      tdsSection: p.tds.sectionCode,
      tdsRatePct: p.tds.applies ? p.tds.ratePct.toFixed(2) : null,
      tdsAmount: p.tds.tdsAmount.toFixed(2),
      status: 'DRAFT',
      lines: {
        create: input.lines.map((l) => {
          const base = round2(new Decimal(l.rate).mul(new Decimal(l.quantity ?? '1')))
          return {
            description: l.description, sacCode: l.sacCode,
            quantity: new Decimal(l.quantity ?? '1').toFixed(3),
            rate: new Decimal(l.rate).toFixed(2),
            taxableValue: base.toFixed(2),
            gstRatePct: new Decimal(l.gstRatePct ?? '18').toFixed(2),
            expenseAccountId: l.expenseAccountCode,
          }
        }),
      },
    },
    include: { lines: true },
  })
  await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'CREATE', after: { billNumber: bill.billNumber, total: p.grandTotal.toFixed(2) } })
  return bill
}

/** Approve: post the bill, the TDS deduction and — for a foreign supplier — the RCM self-invoice. */
export async function approveBill(ctx: RequestContext, billId: string) {
  assertCan(ctx.role, 'bills.approve', 'approve')

  return prisma.$transaction(async (tx) => {
    const bill = await tx.vendorBill.findFirst({
      where: { id: billId, companyId: ctx.companyId },
      include: { lines: true, vendor: true },
    })
    if (!bill) throw new NotFound('Bill not found')
    // VendorBill carries financialYearId as a plain column, not a relation
    const fy = await tx.financialYear.findUniqueOrThrow({ where: { id: bill.financialYearId } })
    if (bill.status !== 'DRAFT') throw new AppError(`Bill ${bill.billNumber} has already been approved`)
    await assertPostable(ctx.companyId, bill.billDate, tx)

    const costByAccount: Record<string, Decimal> = {}
    for (const l of bill.lines) {
      const code = l.expenseAccountId ?? '5200'
      costByAccount[code] = (costByAccount[code] ?? ZERO).plus(l.taxableValue.toString())
    }

    await postJournal(ctx, {
      date: bill.billDate,
      narration: `Bill ${bill.billNumber} — ${bill.vendor.name}`,
      sourceType: 'VENDOR_BILL', sourceId: bill.id,
      postings: postVendorBill({
        billNumber: bill.billNumber, vendorId: bill.vendorId, projectId: bill.projectId,
        costByAccount,
        cgst: new Decimal(bill.cgst.toString()), sgst: new Decimal(bill.sgst.toString()), igst: new Decimal(bill.igst.toString()),
        grandTotal: new Decimal(bill.grandTotal.toString()),
        itcEligible: bill.itcEligible,
      }),
    }, tx)

    // ── TDS ──
    const tdsAmount = new Decimal(bill.tdsAmount.toString())
    if (bill.tdsSection && tdsAmount.gt(0)) {
      await postJournal(ctx, {
        date: bill.billDate,
        narration: `TDS u/s ${bill.tdsSection} — ${bill.vendor.name}`,
        sourceType: 'VENDOR_BILL', sourceId: bill.id,
        postings: postTdsDeduction({ billNumber: bill.billNumber, vendorId: bill.vendorId, sectionCode: bill.tdsSection, tdsAmount }),
      }, tx)

      await tx.tdsDeduction.create({
        data: {
          companyId: ctx.companyId, financialYearId: bill.financialYearId,
          quarter: fyQuarter(bill.billDate),
          sectionCode: bill.tdsSection,
          deducteeType: bill.vendor.country === 'IN' ? 'VENDOR' : 'NON_RESIDENT',
          vendorId: bill.vendorId, deducteePan: bill.vendor.pan,
          documentType: 'VENDOR_BILL', documentId: bill.id,
          deductedOn: bill.billDate,
          baseAmount: bill.taxableValue.toString(),
          ratePct: bill.tdsRatePct?.toString() ?? '0',
          tdsAmount: tdsAmount.toFixed(2),
        },
      })
    }

    // ── reverse charge ──
    let selfInvoiceNo: string | null = null
    const rcmIgst = new Decimal(bill.rcmIgst.toString())
    if (bill.isRcm && rcmIgst.gt(0)) {
      const alloc = await allocateNumber(tx, {
        companyId: ctx.companyId, financialYearId: bill.financialYearId,
        docType: 'SELF_INVOICE', fyLabel: fy.label,
      })
      selfInvoiceNo = alloc.number
      await postJournal(ctx, {
        date: bill.billDate,
        narration: `RCM self-invoice ${selfInvoiceNo} — ${bill.vendor.name}`,
        sourceType: 'SELF_INVOICE', sourceId: bill.id,
        postings: postRcmSelfInvoice({ selfInvoiceNo, vendorId: bill.vendorId, rcmIgst }),
      }, tx)
    }

    const approved = await tx.vendorBill.update({
      where: { id: bill.id },
      data: { status: 'APPROVED', selfInvoiceNo },
    })
    await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'APPROVE', after: { status: 'APPROVED', selfInvoiceNo } }, tx)
    return approved
  })
}

export async function payBill(ctx: RequestContext, input: { billId: string; date: string; amount: string; mode: 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'SWIFT' | 'OTHER'; reference?: string; bankAccountId?: string }) {
  assertCan(ctx.role, 'bills', 'write')
  const date = new Date(input.date)
  await assertPostable(ctx.companyId, date)

  return prisma.$transaction(async (tx) => {
    const bill = await tx.vendorBill.findFirst({ where: { id: input.billId, companyId: ctx.companyId }, include: { vendor: true } })
    if (!bill) throw new NotFound('Bill not found')
    if (bill.status === 'DRAFT') throw new AppError(`Bill ${bill.billNumber} has not been approved yet`)
    if (bill.status === 'CANCELLED') throw new AppError(`Bill ${bill.billNumber} is cancelled`)

    const bank = input.bankAccountId
      ? await tx.companyBankAccount.findFirstOrThrow({ where: { id: input.bankAccountId, companyId: ctx.companyId }, include: { ledgerAccount: true } })
      : await tx.companyBankAccount.findFirstOrThrow({ where: { companyId: ctx.companyId, isDefault: true }, include: { ledgerAccount: true } })
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    const amount = round2(new Decimal(input.amount))
    const owed = new Decimal(bill.grandTotal.toString())
      .minus(bill.tdsAmount.toString())
      .minus(bill.amountPaid.toString())
    if (amount.gt(owed.plus('0.5'))) {
      throw new AppError(`Paying ₹${amount.toFixed(2)} exceeds the ₹${owed.toFixed(2)} outstanding on ${bill.billNumber} — TDS of ₹${bill.tdsAmount} is withheld, not paid to the vendor.`)
    }

    const payment = await tx.billPayment.create({
      data: {
        companyId: ctx.companyId, billId: bill.id, date,
        amount: amount.toFixed(2), mode: input.mode, reference: input.reference, bankAccountId: bank.id,
      },
    })

    await postJournal(ctx, {
      date, narration: `Payment ${bill.billNumber} — ${bill.vendor.name}`,
      sourceType: 'BILL_PAYMENT', sourceId: payment.id,
      postings: postBillPayment({ billNumber: bill.billNumber, vendorId: bill.vendorId, amount, bankAccountCode: bank.ledgerAccount.code }),
    }, tx)

    const paid = new Decimal(bill.amountPaid.toString()).plus(amount)
    await tx.vendorBill.update({
      where: { id: bill.id },
      data: { amountPaid: paid.toFixed(2), status: paid.gte(owed.plus(bill.amountPaid.toString()).minus('0.5')) ? 'PAID' : 'PARTIALLY_PAID' },
    })
    await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'UPDATE', after: { paid: paid.toFixed(2) } }, tx)
    return payment
  })
}

export async function cancelBill(ctx: RequestContext, billId: string, reason: string, on = new Date()) {
  assertCan(ctx.role, 'bills.approve', 'approve')
  if (!reason.trim()) throw new AppError('A cancellation reason is required')

  return prisma.$transaction(async (tx) => {
    const bill = await tx.vendorBill.findFirst({ where: { id: billId, companyId: ctx.companyId } })
    if (!bill) throw new NotFound('Bill not found')
    if (new Decimal(bill.amountPaid.toString()).gt(0)) throw new AppError('Cannot cancel a bill that has been paid')

    if (bill.status !== 'DRAFT') {
      const entries = await tx.journalEntry.findMany({
        where: { companyId: ctx.companyId, sourceId: bill.id, sourceType: { in: ['VENDOR_BILL', 'SELF_INVOICE'] }, reversalOfId: null },
      })
      for (const e of entries) await reverseJournal(ctx, e.id, on, reason, tx)
      // not deleted — the no-hard-delete trigger refuses that, and rightly so
      await tx.tdsDeduction.updateMany({
        where: { documentId: bill.id, challanId: null, reversedAt: null },
        data: { reversedAt: new Date() },
      })
    }

    const cancelled = await tx.vendorBill.update({ where: { id: bill.id }, data: { status: 'CANCELLED' } })
    await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'CANCEL', after: { reason } }, tx)
    return cancelled
  })
}
