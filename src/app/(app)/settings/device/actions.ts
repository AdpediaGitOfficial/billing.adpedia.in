'use server'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { deletePasskey } from '@/server/services/auth/webauthn'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'

/**
 * Revoke a passkey — docs/49.
 *
 * 🔴 Audited. Removing a credential that can sign in to the company's books is a security
 * event; the row itself is gone afterwards, so the audit log is the only remaining record
 * that it ever existed.
 */
export async function removePasskeyAction(
  _prev: { error?: string; ok?: string; removedId?: string } | null, form: FormData,
) {
  const ctx = await requireContext()
  const id = String(form.get('id') ?? '')
  try {
    await deletePasskey(ctx, id)
    await audit(ctx, { entity: 'Passkey', entityId: id, action: 'CANCEL', after: { revoked: true } })
  } catch (e) {
    return { error: e instanceof AppError ? e.message : 'Could not remove that passkey' }
  }
  revalidatePath('/settings/device')
  return { ok: 'Passkey removed', removedId: id }
}
