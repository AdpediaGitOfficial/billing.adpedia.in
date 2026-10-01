import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { PageHeader, Card } from '@/components/ui/kit'
import { NotificationSetup } from '@/components/pwa/notification-setup'
import { InstallPrompt } from '@/components/pwa/install-prompt'

export default async function DevicePage() {
  const ctx = await requireContext()
  const passkeyCount = await prisma.passkey.count({ where: { userId: ctx.userId } })

  return (
    <div className="max-w-xl space-y-5">
      <PageHeader title="This device"
        sub="Notifications, biometric unlock and offline behaviour — all per device, not per account." />

      <InstallPrompt />
      <NotificationSetup publicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''} passkeyCount={passkeyCount} />

      <Card className="p-4">
        <p className="text-[14px] font-semibold">Working offline</p>
        <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Expenses can be filed with no connection — they are stored on this device and sync by
          themselves when you reconnect. Nothing else is cached: reports, balances and invoices
          always come from the server, because a stale figure shown as current is worse than an
          error message.
        </p>
      </Card>
    </div>
  )
}
