import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError } from '@/server/errors'

/**
 * Editing the company's own details — docs/67.
 *
 * 🔴 docs/35 §6 deliberately refused to build this, and gave a good reason:
 *
 * > *Editing company identity changes what appears on documents already issued, so it should
 * > arrive as a migration with an audit trail, not a text box.*
 *
 * That reason stopped being true in **docs/59**. Documents are now archived as PDF bytes at
 * the moment they are issued, and the routes serve the archive rather than re-rendering — so
 * correcting the address today cannot rewrite the invoice a client received in May. The
 * premise changed, so the decision is revisited rather than inherited.
 *
 * What has not changed is that some of these fields are not cosmetic at all.
 */

/**
 * 🔴 The line between the two halves, and why it falls here.
 *
 * - **PAN, GSTIN, CIN** — quoted in filed returns and on every challan. Changing one makes
 *   GSTR-1 disagree with the portal, and nothing here can tell a correction from a different
 *   company.
 * - **Legal name** — the invoice series and the filed returns are issued under it.
 * - **State code** — derives the tax mode on every future invoice, CGST+SGST or IGST. A text
 *   box that silently re-heads the tax on everything sold after it is not an edit.
 *
 * A genuine change to any of these is a new registration or a rectification: it wants the CA
 * and a migration. The screen shows them beside the editable fields and says so, rather than
 * hiding them and leaving somebody hunting.
 */
export const FIXED_FIELDS = ['legalName', 'pan', 'gstin', 'cin', 'stateCode'] as const

export interface CompanyProfileInput {
  tradeName?: string
  tan?: string
  email?: string
  phone?: string
  website?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  pincode?: string
  country?: string
}

/** A TAN is four letters, five digits, one letter — the same shape as a deductor's. */
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/
const PIN_RE = /^\d{6}$/

export async function updateCompanyProfile(ctx: RequestContext, input: CompanyProfileInput) {
  assertCan(ctx.role, 'settings.company', 'write')

  const before = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    select: { tradeName: true, tan: true, email: true, phone: true, website: true, registeredAddress: true },
  })

  const tan = input.tan?.trim().toUpperCase() || null
  if (tan && !TAN_RE.test(tan)) {
    throw new AppError(`"${tan}" is not a TAN — four letters, five digits, one letter, as on the TDS certificate`)
  }
  if (input.pincode?.trim() && !PIN_RE.test(input.pincode.trim())) {
    throw new AppError(`"${input.pincode}" is not a pincode — six digits`)
  }
  // rule 46(c) requires the supplier's address on every tax invoice
  if (!input.addressLine1?.trim()) {
    throw new AppError('The registered address needs at least a first line — it prints on every invoice')
  }

  const data = {
    tradeName: input.tradeName?.trim() || null,
    tan,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    website: input.website?.trim() || null,
    registeredAddress: {
      line1: input.addressLine1.trim(),
      line2: input.addressLine2?.trim() ?? '',
      city: input.city?.trim() ?? '',
      state: input.state?.trim() ?? '',
      pincode: input.pincode?.trim() ?? '',
      country: input.country?.trim() || 'India',
    },
  }

  const company = await prisma.company.update({ where: { id: ctx.companyId }, data })

  /**
   * 🔴 Audited with the before AND the after, in full.
   *
   * docs/35 asked for "a migration with an audit trail" rather than a text box. This is the
   * text box; the audit trail was the load-bearing half, and `AuditLog` is append-only by
   * database trigger — so what the address was on the day an old invoice went out stays
   * answerable even though the field has moved on.
   */
  await audit(ctx, { entity: 'Company', entityId: ctx.companyId, action: 'UPDATE', before, after: data })
  return company
}
