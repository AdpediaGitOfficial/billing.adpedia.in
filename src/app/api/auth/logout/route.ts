import { handler } from '@/app/api/_lib/handler'
import { logout } from '@/server/auth/service'

export async function POST() {
  return handler(async () => { await logout(); return { ok: true } })
}
