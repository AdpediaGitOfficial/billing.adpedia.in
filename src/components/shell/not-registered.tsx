import { prisma } from '@/server/db'
import { PageHeader, Alert } from '@/components/ui/kit'
import { isGstRegistered } from '@/server/services/invoicing/document-type'

/**
 * docs/82 §5 — the GST screens, for an entity that is not registered for GST.
 *
 * 🔴 `nav.ts` says of itself that "the server also refuses whatever the UI hides", and hiding
 * these from the rail is not refusing them: the URL is still there, and a bookmark or a typed
 * path reaches the page. The LUT register is the one that matters most — it invites zero-rating
 * an export that an unregistered person cannot zero-rate.
 *
 * It explains rather than 404s, because the person is not lost: they are in the other entity.
 */
export async function requireGstRegistered(companyId: string, what: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { legalName: true, gstRegistrationType: true },
  })
  if (isGstRegistered(company.gstRegistrationType)) return null

  return (
    <div>
      <PageHeader title={what} />
      <Alert tone="warn" title={`${company.legalName} is not registered for GST`}>
        {what} belongs to a registered person. This entity issues bills of supply at nil rate
        under rule 49, charges no tax and claims no credit, so there is nothing here to file,
        set off or declare. Switch to the entity that is registered, or register this one first.
      </Alert>
    </div>
  )
}
