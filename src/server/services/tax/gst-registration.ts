import type { GstRegType } from '@prisma/client'
import { prisma } from '@/server/db'
import { AppError } from '@/server/errors'
import { isGstRegistered } from '@/server/services/invoicing/document-type'

/**
 * The GST surface, gated on the registration — docs/82 §4.
 *
 * 🔴 `nav.ts` hides the GST items from an unregistered entity's rail, and `not-registered.tsx`
 * explains the three screens that hiding does not protect. Neither of those is a refusal: a
 * server action is reached by posting to it, `/api/tax/gst/export` is a URL, and the nav is a
 * list of links rather than a permission. What a registered person does, an unregistered one
 * must be told it cannot do, by the code that would otherwise do it.
 *
 * And the harm is not a crash. Every one of these paths would have WORKED for entity B:
 * a GSTR-1 would have been built from its bills of supply, a filing recorded against a return
 * it must not file, a challan posted for tax it never collected. Plausible figures for a
 * taxpayer that does not exist, in books an assessment reads.
 */

/**
 * 🔴 Files GSTR-1 and GSTR-3B — which is narrower than "registered".
 *
 * A composition taxpayer is registered, has a GSTIN, and files CMP-08 quarterly with GSTR-4
 * annually. It has no GSTR-1 and no GSTR-3B. Keying these screens off the GSTIN — which is
 * what the calendar did — hands a composition dealer a monthly return it does not file and a
 * set-off it does not compute, and the figures look right the whole way.
 */
export function filesGstr1And3b(registration: GstRegType): boolean {
  return registration === 'REGULAR'
}

async function registrationOf(companyId: string) {
  return prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { legalName: true, gstRegistrationType: true },
  })
}

/**
 * Registered at all. The LUT register, the electronic ledgers, a challan, a 2B — all of them
 * presuppose a registration, whatever its flavour.
 */
export async function assertGstRegistered(companyId: string, what: string): Promise<void> {
  const co = await registrationOf(companyId)
  if (isGstRegistered(co.gstRegistrationType)) return

  throw new AppError(
    `${co.legalName} is not registered for GST, so ${what} does not apply to it. This entity `
    + 'issues bills of supply under rule 49, charges no tax and claims no credit. Switch to the '
    + 'entity that is registered, or register this one first.',
    409,
    'NOT_GST_REGISTERED',
  )
}

/** The returns this system actually produces, and the registration that files them. */
export async function assertFilesGstr1And3b(companyId: string, what: string): Promise<void> {
  const co = await registrationOf(companyId)
  if (filesGstr1And3b(co.gstRegistrationType)) return

  throw new AppError(
    isGstRegistered(co.gstRegistrationType)
      ? `${co.legalName} pays tax under s.10, so it files CMP-08 and GSTR-4 — not GSTR-1 and `
        + `GSTR-3B. ${what} is not a return it files, and this system does not produce the ones `
        + 'it does.'
      : `${co.legalName} is not registered for GST, so there is no ${what} to build. Its `
        + 'outward supplies are bills of supply under rule 49 and appear in no GST return.',
    409,
    'NOT_GST_REGISTERED',
  )
}
