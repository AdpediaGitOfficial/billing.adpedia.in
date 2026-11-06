import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { previewBill } from '@/server/services/purchases/bill'

const Body = z.object({
  vendorId: z.string().min(1),
  billNumber: z.string().default('PREVIEW'),
  billDate: z.string().min(1),
  tdsSection: z.string().nullable().optional(),
  itcEligible: z.boolean().optional(),
  currency: z.string().optional(),
  fxRate: z.string().optional(),
  lines: z.array(z.object({
    description: z.string().default(''),
    sacCode: z.string().optional(),
    quantity: z.string().default('1'),
    rate: z.string().default('0'),
    gstRatePct: z.string().optional(),
    expenseAccountCode: z.string().default('5200'),
  })).min(1),
})

/** Live TDS, reverse charge and ITC position for the bill form. */
export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    assertCan(ctx.role, 'bills', 'write')
    const p = await previewBill(ctx, Body.parse(await req.json()))
    return {
      vendor: p.vendor,
      taxableValue: p.taxableValue.toFixed(2),
      cgst: p.cgst.toFixed(2), sgst: p.sgst.toFixed(2), igst: p.igst.toFixed(2),
      grandTotal: p.grandTotal.toFixed(2),
      rcmIgst: p.rcmIgst.toFixed(2),
      netPayable: p.netPayable.toFixed(2),
      itcEligible: p.itcEligible,
      // docs/93 — copied field by field like the rest: the form shows the rupee figures from these
      currency: p.currency,
      fxRate: p.fxRate.toFixed(6),
      grandTotalInr: p.grandTotalInr ? p.grandTotalInr.toFixed(2) : null,
      tdsAmountDoc: p.tdsAmountDoc.toFixed(2),
      warnings: p.warnings,
      tds: {
        applies: p.tds.applies,
        section: p.tds.sectionCode,
        ratePct: p.tds.ratePct.toFixed(2),
        applyOn: p.tds.applyOn.toFixed(2),
        amount: p.tds.tdsAmount.toFixed(2),
        reason: p.tds.reason,
        cumulativeBefore: p.tds.cumulativeBefore.toFixed(2),
        cumulativeAfter: p.tds.cumulativeAfter.toFixed(2),
      },
    }
  })
}
