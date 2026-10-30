'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireContext } from '@/server/context'
import { prisma } from '@/server/db'
import { signAccessToken } from '@/server/auth/jwt'
import { setAccessCookie } from '@/server/auth/service'
import { switchCompany } from '@/server/services/company/switch'
import { createCompany } from '@/server/services/company/create'
import { AppError, Forbidden } from '@/server/errors'
import type { Constitution } from '@prisma/client'

/**
 * docs/82 §3 — entering the other entity.
 *
 * 🔴 The companyId arrives in a form body, which makes it a request and not a fact.
 * `switchCompany` re-reads the membership from the database before anything is signed; without
 * that this form would be a way to read any company in the installation by guessing an id.
 */
export async function switchCompanyAction(_prev: { error?: string } | null, form: FormData) {
  const ctx = await requireContext()
  const companyId = String(form.get('companyId') ?? '')
  if (companyId === ctx.companyId) return { error: 'You are already in those books' }

  try {
    const target = await switchCompany(ctx, companyId)
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId }, select: { tokenVersion: true },
    })
    await setAccessCookie(await signAccessToken({
      sub: ctx.userId, companyId: target.companyId, role: target.role, tokenVersion: user.tokenVersion,
    }))
  } catch (e) {
    if (e instanceof Forbidden || e instanceof AppError) return { error: e.message }
    return { error: 'Could not switch company' }
  }

  // 🔴 everything cached was rendered for the OTHER entity's books
  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function createCompanyAction(
  _prev: { error?: string; ok?: string } | null,
  form: FormData,
) {
  const ctx = await requireContext()
  const str = (k: string) => String(form.get(k) ?? '').trim()

  try {
    const company = await createCompany(ctx, {
      legalName: str('legalName'),
      constitution: str('constitution') as Constitution,
      pan: str('pan'),
      gstin: str('gstin') || null,
      stateCode: str('stateCode'),
      seriesPrefix: str('seriesPrefix'),
      bankLabel: str('bankLabel') || undefined,
      signatoryName: str('signatoryName') || undefined,
      signatoryDesignation: str('signatoryDesignation') || undefined,
      email: str('email') || undefined,
      phone: str('phone') || undefined,
      address: {
        line1: str('line1'), line2: str('line2'), city: str('city'),
        state: str('state'), pincode: str('pincode'),
      },
    })
    revalidatePath('/settings/companies')
    return { ok: `${company.legalName} is ready — switch to it to start billing` }
  } catch (e) {
    if (e instanceof Forbidden || e instanceof AppError) return { error: e.message }
    return { error: 'Could not create that company' }
  }
}
