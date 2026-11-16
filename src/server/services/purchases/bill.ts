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
import { requireDefaultBank } from '@/server/services/company/bank-account'
import { isGstRegistered } from '@/server/services/invoicing/document-type'
import { isForeign, rateIsSet, toInr, formatDocAmount } from '@/lib/fx'
import { documentFxRate } from '@/server/services/fx-rate'
import { billInr, clearedInr } from '@/lib/bill-fx'

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
  /** docs/93 — the currency the vendor billed in; line amounts are in it. Default INR. */
  currency?: string
  /** rupees per one unit of `currency`, on the bill date. Foreign only. */
  fxRate?: string
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
  /** docs/93 — the bill's currency and the rate it is booked at */
  currency: string
  fxRate: Decimal
  /** the bill in rupees as it will be booked; null when it is in rupees already or has no rate yet */
  grandTotalInr: Decimal | null
  /** TDS in the bill's own currency (`tds.tdsAmount` is rupees: the decision is made in rupees) */
  tdsAmountDoc: Decimal
  /** the entity is GST-registered — decides whether input credit and reverse charge exist at all */
  registered: boolean
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

  const currency = (input.currency ?? 'INR').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(`"${input.currency}" is not a currency code — use the three-letter code, like USD.`)
  const fxRate = documentFxRate(currency, input.fxRate)
  const foreign = isForeign(currency)
  if (foreign && !rateIsSet(currency, fxRate)) {
    warnings.push(`Enter the exchange rate for this ${currency} bill — rupees per one ${currency} on the bill date. The books are kept in rupees, and the TDS and reverse charge below are worked out on the rupee value.`)
  }

  let taxableValue = ZERO, cgst = ZERO, sgst = ZERO, igst = ZERO
  const costByAccount: Record<string, Decimal> = {}
  for (const l of input.lines) {
    const base = round2(new Decimal(l.rate).mul(new Decimal(l.quantity ?? '1')))
    const g = splitGst(base, new Decimal(l.gstRatePct ?? '18'), mode)
    taxableValue = taxableValue.plus(base)
    cgst = cgst.plus(g.cgst); sgst = sgst.plus(g.sgst); igst = igst.plus(g.igst)
    costByAccount[l.expenseAccountCode] = (costByAccount[l.expenseAccountCode] ?? ZERO).plus(base)
  }
  const grandTotal = taxableValue.plus(cgst).plus(sgst).plus(igst)
  // docs/93 — the bill in rupees: each cost account and tax head converted on its own, the total
  // being what they add up to. Everything statutory below (reverse charge, TDS) works on this.
  const inr = foreign && rateIsSet(currency, fxRate) ? billInr({ costByAccount, cgst, sgst, igst }, fxRate) : null
  const taxableInr = foreign ? toInr(taxableValue, fxRate) : taxableValue

  // 🔴 reverse charge — the supplier charges nothing, Adpedia self-accounts IGST
  /**
   * 🔴 docs/89 — credit under s.16(1) belongs to a REGISTERED person. For an unregistered
   * entity the GST a vendor charged is part of the cost, and the reverse-charge half is not
   * ours to account for: `postRcmSelfInvoice` debits 1240 as a recoverable asset, which for
   * this entity is a debit that can never be utilised. Nothing here can say whether an
   * unregistered recipient owes the IGST at all, so it is named and left, as docs/79 does.
   */
  const registered = isGstRegistered(company.gstRegistrationType)
  const rcmIgst = vendor.rcmApplicable && registered ? round2(taxableInr.mul(RCM_RATE).div(100)) : ZERO
  if (vendor.rcmApplicable && !registered) {
    warnings.push(
      `${vendor.name} has no Indian GSTIN, so this may be an import of service liable to reverse charge. ` +
      'This entity is not registered for GST, and this system will not account for IGST under reverse charge ' +
      'for it — no self-invoice is raised and no input credit is booked. Ask the CA before approving it.',
    )
  } else if (vendor.rcmApplicable) {
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
    thisBillBase: taxableInr,   // docs/93 — thresholds and rates are on the rupee value
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
  // the deduction is decided in rupees and subtracted from the bill in its own currency. The
  // rupee figure is kept exactly (`tds.tdsAmount`); this is only what the vendor is NOT paid.
  const tdsAmountDoc = foreign ? round2(tds.tdsAmount.div(fxRate)) : tds.tdsAmount

  if (vendor.country !== 'IN' && section === '195') {
    warnings.push(
      'Payments to a non-resident need Form 15CA, and Form 15CB from a chartered accountant, BEFORE the remittance is made. The treaty rate also requires a Tax Residency Certificate and Form 10F from the payee.',
    )
  }

  if (!registered && input.itcEligible) {
    throw new AppError(
      'This entity is not registered for GST, so there is no input credit to claim — s.16(1) '
      + 'gives credit to a registered person. The tax the vendor charged is part of the cost '
      + 'of the bill, and that is where it is posted.',
    )
  }
  const itcEligible = registered && (input.itcEligible ?? (mode !== 'NONE'))
  if (!registered && (cgst.gt(0) || sgst.gt(0) || igst.gt(0))) {
    warnings.push('This entity is not registered for GST, so the GST on this bill is part of its cost — there is no input credit to claim.')
  } else if (!itcEligible && (cgst.gt(0) || sgst.gt(0) || igst.gt(0))) {
    warnings.push('Input credit is blocked on this bill, so the GST becomes part of the cost rather than a recoverable asset.')
  }

  return {
    vendor: { id: vendor.id, name: vendor.name, isForeignSupplier: vendor.isForeignSupplier, rcmApplicable: vendor.rcmApplicable, pan: vendor.pan, panVerified: vendor.panVerified },
    taxableValue, cgst, sgst, igst, grandTotal, rcmIgst, tds,
    currency, fxRate, grandTotalInr: inr ? inr.grand : null, tdsAmountDoc,
    netPayable: grandTotal.minus(tdsAmountDoc),
    itcEligible, registered, warnings,
  }
}

export async function createBill(ctx: RequestContext, input: BillInput) {
  assertCan(ctx.role, 'bills', 'write')
  if (input.lines.length === 0) throw new AppError('A bill needs at least one line')

  const p = await previewBill(ctx, input)
  /**
   * 🔴 docs/93 — a foreign bill is not saved without the rate it is booked at. Unlike an invoice
   * draft this cannot wait for approval: the TDS and the reverse charge are worked out HERE, on
   * the rupee value, and a rate of 1 would work them out on dollars.
   */
  if (isForeign(p.currency) && !rateIsSet(p.currency, p.fxRate)) {
    throw new AppError(`Enter the exchange rate for this ${p.currency} bill before saving it — rupees per one ${p.currency} on the bill date.`)
  }
  const billDate = new Date(input.billDate)
  const fy = await assertPostable(ctx.companyId, billDate)
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: input.vendorId } })

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
      currency: p.currency, fxRate: p.fxRate.toFixed(6),
      grandTotalInr: p.grandTotalInr ? p.grandTotalInr.toFixed(2) : null,
      taxableValue: p.taxableValue.toFixed(2),
      cgst: p.cgst.toFixed(2), sgst: p.sgst.toFixed(2), igst: p.igst.toFixed(2),
      grandTotal: p.grandTotal.toFixed(2),
      isRcm: p.rcmIgst.gt(0), rcmIgst: p.rcmIgst.toFixed(2),
      itcEligible: p.itcEligible,
      itcBlockedReason: p.registered ? input.itcBlockedReason
        : 'The entity is not registered for GST — s.16(1) gives credit to a registered person only',
      // the section is stored even when nothing is deducted — a bill below the
      // threshold still counts toward it, and the cumulative lookup reads this column
      tdsSection: p.tds.sectionCode,
      tdsRatePct: p.tds.applies ? p.tds.ratePct.toFixed(2) : null,
      tdsAmount: p.tdsAmountDoc.toFixed(2),
      tdsAmountInr: isForeign(p.currency) ? p.tds.tdsAmount.toFixed(2) : null,
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
    const fy = await tx.financialYear.findUniqueOrThrow({ where: { companyId: ctx.companyId, id: bill.financialYearId } })
    if (bill.status !== 'DRAFT') throw new AppError(`Bill ${bill.billNumber} has already been approved`)
    await assertPostable(ctx.companyId, bill.billDate, tx)

    const costByAccount: Record<string, Decimal> = {}
    for (const l of bill.lines) {
      const code = l.expenseAccountId ?? '5200'
      costByAccount[code] = (costByAccount[code] ?? ZERO).plus(l.taxableValue.toString())
    }

    /**
     * 🔴 docs/93 — a foreign bill is posted in rupees at the rate it carries: every cost account
     * and tax head converted on its own, payables credited with their sum. Before this the
     * dollars were posted as rupees, so a person had to convert by hand before keying it.
     */
    const foreign = isForeign(bill.currency)
    if (foreign && !rateIsSet(bill.currency, bill.fxRate.toString())) {
      throw new AppError(`${bill.billNumber} is in ${bill.currency} and has no exchange rate, so it cannot be posted to a rupee ledger.`)
    }
    const rate = new Decimal(bill.fxRate.toString())
    const inr = foreign
      ? billInr({
          costByAccount,
          cgst: new Decimal(bill.cgst.toString()), sgst: new Decimal(bill.sgst.toString()), igst: new Decimal(bill.igst.toString()),
        }, rate)
      : null

    await postJournal(ctx, {
      date: bill.billDate,
      narration: `Bill ${bill.billNumber} — ${bill.vendor.name}`,
      sourceType: 'VENDOR_BILL', sourceId: bill.id,
      postings: postVendorBill({
        billNumber: bill.billNumber, vendorId: bill.vendorId, projectId: bill.projectId,
        costByAccount: inr ? inr.costByAccount : costByAccount,
        cgst: inr ? inr.cgst : new Decimal(bill.cgst.toString()),
        sgst: inr ? inr.sgst : new Decimal(bill.sgst.toString()),
        igst: inr ? inr.igst : new Decimal(bill.igst.toString()),
        grandTotal: inr ? inr.grand : new Decimal(bill.grandTotal.toString()),
        itcEligible: bill.itcEligible,
      }),
    }, tx)

    // ── TDS ── in rupees: the deduction, the challan and the 27Q/26Q row are rupee figures
    const tdsAmount = new Decimal((bill.tdsAmountInr ?? bill.tdsAmount).toString())
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
          baseAmount: foreign ? toInr(bill.taxableValue.toString(), rate).toFixed(2) : bill.taxableValue.toString(),
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
      where: { companyId: ctx.companyId, id: bill.id },
      data: { status: 'APPROVED', selfInvoiceNo },
    })
    await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'APPROVE', after: { status: 'APPROVED', selfInvoiceNo } }, tx)
    return approved
  })
}

export async function payBill(ctx: RequestContext, input: { billId: string; date: string; amount: string; /** rupees that left the bank — foreign bills only (docs/93) */ inrAmount?: string; mode: 'NEFT' | 'RTGS' | 'IMPS' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'SWIFT' | 'OTHER'; reference?: string; bankAccountId?: string }) {
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
      : await requireDefaultBank(tx, ctx.companyId)
    if (!bank.ledgerAccount) throw new AppError(`Bank account ${bank.label} is not mapped to a ledger account`)

    const amount = round2(new Decimal(input.amount))
    const owedTotal = new Decimal(bill.grandTotal.toString()).minus(bill.tdsAmount.toString())
    const owed = owedTotal.minus(bill.amountPaid.toString())
    if (amount.gt(owed.plus('0.5'))) {
      throw new AppError(`Paying ${formatDocAmount(bill.currency, amount)} exceeds the ${formatDocAmount(bill.currency, owed)} outstanding on ${bill.billNumber} — TDS of ${formatDocAmount(bill.currency, bill.tdsAmount.toString())} is withheld, not paid to the vendor.`)
    }

    /**
     * 🔴 docs/93 — a foreign bill is paid in its own currency and leaves the bank in rupees. The
     * person types the rupees; the realised forex is DERIVED, never typed: rupees out, less the
     * rupees of payables this payment clears at the BILL's rate. Positive is a loss (5900), and
     * a card's own markup lands there too.
     */
    const foreign = isForeign(bill.currency)
    let inrAmount: Decimal | null = null
    let apCleared: Decimal | undefined
    if (foreign) {
      if (!rateIsSet(bill.currency, bill.fxRate.toString()) || !bill.grandTotalInr) {
        throw new AppError(`${bill.billNumber} is in ${bill.currency} and was never booked at an exchange rate, so it cannot be paid from a rupee ledger.`)
      }
      inrAmount = input.inrAmount ? round2(new Decimal(input.inrAmount)) : null
      if (!inrAmount || inrAmount.lte(0)) {
        throw new AppError(`Enter the rupees that left the bank for this ${bill.currency} payment. The books are kept in rupees, and the difference from the bill's rate is booked as forex gain or loss.`)
      }
      const priorPayments = await tx.billPayment.findMany({ where: { companyId: ctx.companyId, billId: bill.id }, select: { id: true } })
      const prior = await tx.journalLine.findMany({
        where: { account: { code: '2000', companyId: ctx.companyId }, journalEntry: { sourceType: 'BILL_PAYMENT', sourceId: { in: priorPayments.map((p) => p.id) } } },
        select: { debit: true, credit: true },
      })
      const alreadyCleared = prior.reduce((a, l) => a.plus(l.debit.toString()).minus(l.credit.toString()), ZERO)
      const payableInr = new Decimal(bill.grandTotalInr.toString()).minus((bill.tdsAmountInr ?? 0).toString())
      const paidAfter = new Decimal(bill.amountPaid.toString()).plus(amount)
      apCleared = clearedInr(payableInr, owedTotal, paidAfter, alreadyCleared, paidAfter.gte(owedTotal.minus('0.5')))
    } else if (input.inrAmount) {
      throw new AppError('The rupees paid are only for a foreign-currency bill.')
    }

    const payment = await tx.billPayment.create({
      data: {
        companyId: ctx.companyId, billId: bill.id, date,
        amount: amount.toFixed(2), inrAmount: inrAmount ? inrAmount.toFixed(2) : null,
        mode: input.mode, reference: input.reference, bankAccountId: bank.id,
      },
    })

    await postJournal(ctx, {
      date, narration: `Payment ${bill.billNumber} — ${bill.vendor.name}`,
      sourceType: 'BILL_PAYMENT', sourceId: payment.id,
      postings: postBillPayment({
        billNumber: bill.billNumber, vendorId: bill.vendorId,
        amount: inrAmount ?? amount, bankAccountCode: bank.ledgerAccount.code, apCleared,
      }),
    }, tx)

    const paid = new Decimal(bill.amountPaid.toString()).plus(amount)
    await tx.vendorBill.update({
      where: { companyId: ctx.companyId, id: bill.id },
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
        where: { companyId: ctx.companyId, documentId: bill.id, challanId: null, reversedAt: null },
        data: { reversedAt: new Date() },
      })
    }

    const cancelled = await tx.vendorBill.update({ where: { companyId: ctx.companyId, id: bill.id }, data: { status: 'CANCELLED' } })
    await audit(ctx, { entity: 'VendorBill', entityId: bill.id, action: 'CANCEL', after: { reason } }, tx)
    return cancelled
  })
}
