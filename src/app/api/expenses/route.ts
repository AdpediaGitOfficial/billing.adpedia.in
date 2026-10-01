import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { createExpense } from '@/server/services/purchases/expense'

const Body = z.object({
  categoryId: z.string().min(1),
  date: z.string().min(1),
  description: z.string().min(1),
  taxableValue: z.string().min(1),
  gstRatePct: z.string().optional(),
  gstMode: z.enum(['INTRA', 'INTER', 'NONE']).optional(),
  projectId: z.string().optional(),
  vendorId: z.string().optional(),
  paidFrom: z.enum(['BANK', 'CASH', 'CARD', 'PERSONAL_REIMBURSABLE']).optional(),
  itcEligible: z.boolean().optional(),
  receiptUrl: z.string().optional(),
  /** set by the offline queue so a replay is a no-op */
  clientKey: z.string().min(8).max(64).optional(),
})

export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const body = Body.parse(await req.json())
    const expense = await createExpense(ctx, body)
    return { id: expense.id, total: expense.total.toString(), clientKey: expense.clientKey }
  })
}
