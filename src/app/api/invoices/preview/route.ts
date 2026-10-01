import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { previewInvoice } from '@/server/services/invoicing/invoice'

const Body = z.object({
  customerId: z.string().min(1),
  date: z.string().min(1),
  tdsSection: z.enum(['194J', '194C']).nullable().optional(),
  lines: z.array(z.object({
    description: z.string().default(''),
    sacCode: z.string().optional(),
    quantity: z.string().default('1'),
    rate: z.string().default('0'),
    discountPct: z.string().optional(),
    gstRatePct: z.string().optional(),
  })).min(1),
})

/** Live totals for the invoice form. Computes with the same engine that saves. */
export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const body = Body.parse(await req.json())
    const p = await previewInvoice(ctx, body)
    return {
      taxMode: p.taxMode,
      placeOfSupplyLabel: p.placeOfSupplyLabel,
      currency: p.currency,
      requiresLut: p.requiresLut,
      nextNumber: p.nextNumber,
      sacIssues: p.sacIssues,
      totals: {
        taxableValue: p.totals.taxableValue.toFixed(2),
        cgst: p.totals.cgst.toFixed(2),
        sgst: p.totals.sgst.toFixed(2),
        igst: p.totals.igst.toFixed(2),
        roundOff: p.totals.roundOff.toFixed(2),
        grandTotal: p.totals.grandTotal.toFixed(2),
        lines: p.totals.lines.map((l) => ({ taxableValue: l.taxableValue.toFixed(2) })),
      },
      tds: { section: p.tds.section, tdsAmount: p.tds.tdsAmount.toFixed(2), netPayable: p.tds.netPayable.toFixed(2) },
    }
  })
}
