import { handler } from '@/app/api/_lib/handler'
import { refresh } from '@/server/auth/service'
import { clientMeta } from '@/server/context'

export async function POST() {
  return handler(async () => refresh(await clientMeta()))
}
