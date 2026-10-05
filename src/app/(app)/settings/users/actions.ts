'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { createInvitation, revokeInvitation } from '@/server/services/auth/invitation'
import { changeRole, setUserActive } from '@/server/services/auth/membership'
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

export async function changeRoleAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await changeRole(ctx, String(form.get('userId') ?? ''), String(form.get('role') ?? '') as Role,
      String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not change that role' }
  }
  revalidatePath('/settings/users')
  return { ok: 'Changed' }
}

/**
 * 🔴 "Removing" somebody is deactivating them — docs/77. The user row stays, because every
 * audit entry and every journal entry points at an id that has to keep resolving.
 */
export async function setUserActiveAction(_prev: { error?: string; ok?: string } | null, form: FormData) {
  const ctx = await requireContext()
  try {
    await setUserActive(ctx, String(form.get('userId') ?? ''), Boolean(form.get('active')),
      String(form.get('reason') ?? ''))
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not change that access' }
  }
  revalidatePath('/settings/users')
  return { ok: 'Saved' }
}
