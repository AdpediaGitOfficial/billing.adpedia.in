'use server'
import { redirect } from 'next/navigation'
import { acceptInvitation } from '@/server/services/auth/invitation'
import { AppError } from '@/server/errors'

/**
 * 🔴 Redirects to /login rather than signing anybody in — docs/73.
 *
 * An invitation link that creates a session is a password sitting in a mailbox. Setting the
 * password is the end of this flow; the next thing that happens is an ordinary sign-in, with
 * everything that guards one.
 */
export async function acceptInvitationAction(_prev: { error?: string } | null, form: FormData) {
  try {
    await acceptInvitation({
      token: String(form.get('token') ?? ''),
      password: String(form.get('password') ?? ''),
    })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not set that password' }
  }
  redirect('/login?invited=1')
}
