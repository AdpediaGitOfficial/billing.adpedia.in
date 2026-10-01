import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { registrationOptions, verifyRegistration } from '@/server/services/auth/webauthn'

export async function GET() {
  return handler(async () => registrationOptions(await requireContext()))
}

const Body = z.object({ response: z.any(), label: z.string().max(60).optional() })

export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const { response, label } = Body.parse(await req.json())
    return verifyRegistration(ctx, response, label)
  })
}
