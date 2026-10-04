import { inviteeFor } from '@/server/services/auth/invitation'
import { Card } from '@/components/ui/kit'
import { AcceptForm } from './form'

/**
 * Accepting an invitation — docs/73.
 *
 * 🔴 Reachable without a session, by design: the person has no account yet. The middleware
 * lets `/invite` through for exactly this reason, and `tests/public-routes.test.ts` requests
 * the route rather than trusting that line — docs/30 §8, where the service worker was being
 * redirected to /login and the offline queue died silently.
 *
 * 🔴 Unknown, expired, revoked and already-accepted all render the same page. Anything else
 * makes this an oracle for whether a token ever existed and whether it is still live.
 */
export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invitee = await inviteeFor(token)

  if (!invitee) {
    return (
      <Shell>
        <p className="text-[15px] font-semibold">This link is not valid</p>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          It may have been used already, withdrawn, or simply expired — invitations last a week. Ask whoever
          invited you to send a new one.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <p className="eyebrow">{invitee.companyName}</p>
      <h1 className="mt-1 text-[20px] font-semibold leading-tight">Welcome, {invitee.name}</h1>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        You have been invited as <strong>{invitee.role.replace('_', ' ').toLowerCase()}</strong>, under{' '}
        <strong>{invitee.email}</strong>. Choose a password and you are done — this page does not sign you in,
        so you will log in with it in a moment.
      </p>
      <div className="mt-5">
        <AcceptForm token={token} />
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center px-5">
      <Card className="w-full p-6">{children}</Card>
    </div>
  )
}
