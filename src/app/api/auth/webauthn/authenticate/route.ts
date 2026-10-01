import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { authenticationOptions, verifyAuthentication } from '@/server/services/auth/webauthn'

export async function GET() {
  return handler(async () => authenticationOptions(await requireContext()))
}

const Body = z.object({ response: z.any() })

export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const { response } = Body.parse(await req.json())
    return verifyAuthentication(ctx, response)
  })
}
