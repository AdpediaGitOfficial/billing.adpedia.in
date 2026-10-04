'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { createInvitation, revokeInvitation } from '@/server/services/auth/invitation'
import { AppError } from '@/server/errors'
import type { Role } from '@prisma/client'

/**
 * 🔴 The token comes back in the action's result and is shown once — docs/73.
 *
 * It is never stored in plaintext and cannot be read again, which means the owner has exactly
 * one chance to copy the link. That is the trade: a token that can be looked up later is a
 * token sitting in a database, and this one is a credential.
 */
export async function inviteUserAction(
  _prev: { error?: string; link?: string; email?: string } | null,
  form: FormData,
) {
  const ctx = await requireContext()
  try {
    const { token, invitation } = await createInvitation(ctx, {
      email: String(form.get('email') ?? ''),
      name: String(form.get('name') ?? ''),
      role: String(form.get('role') ?? 'EMPLOYEE') as Role,
    })
    revalidatePath('/settings/users')
    return { link: `/invite/${token}`, email: invitation.email }
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not create that invitation' }
  }
}

export async function revokeInvitationAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await revokeInvitation(ctx, String(form.get('invitationId') ?? ''), String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not revoke that invitation' }
  }
  revalidatePath('/settings/users')
  return { ok: 'Revoked' }
}
