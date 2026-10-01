import { z } from 'zod'
import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'

const Body = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const { endpoint, keys } = Body.parse(await req.json())

    // re-subscribing on the same device returns the same endpoint; upsert also clears a
    // previous failure so a reinstalled browser starts receiving again
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: ctx.userId, p256dh: keys.p256dh, auth: keys.auth, failedAt: null },
      create: {
        userId: ctx.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth,
        userAgent: req.headers.get('user-agent')?.slice(0, 200),
      },
    })
    return { ok: true }
  })
}

export async function DELETE(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(await req.json())
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: ctx.userId } })
    return { ok: true }
  })
}
