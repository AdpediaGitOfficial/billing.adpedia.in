import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { login } from '@/server/auth/service'
import { clientMeta } from '@/server/context'

const Body = z.object({ email: z.string().email(), password: z.string().min(1) })

export async function POST(req: Request) {
  return handler(async () => {
    const body = Body.parse(await req.json())
    return login(body.email, body.password, await clientMeta())
  })
}
