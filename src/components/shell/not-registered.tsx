import { prisma } from '@/server/db'
import { PageHeader, Alert } from '@/components/ui/kit'
import { isGstRegistered } from '@/server/services/invoicing/document-type'
import { hasDrawings } from '@/server/services/equity/drawings'

/*
 * Two gates of the same shape: a screen that belongs to a kind of entity this one is not.
 * Both explain rather than 404, because the person is not lost — they are in the other entity.
 */

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

/**
 * docs/82 §4 — the drawings register, on a company's books.
 *
 * 🔴 The mirror of the GST gate, and the reason it says so much: the three transactions it
 * names are not interchangeable, and a company treating a withdrawal as a drawing has skipped
 * either a salary with TDS, a dividend out of taxed profit, or a loan it owes back.
 */
export async function requireDrawings(companyId: string, what: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { legalName: true, constitution: true },
  })
  if (hasDrawings(company.constitution)) return null

  return (
    <div>
      <PageHeader title={what} />
      <Alert tone="warn" title={`${company.legalName} is a company, and a company has no drawings`}>
        A company is a legal person separate from its shareholders, so there is no informal way
        to take money out of it. What looks like a drawing is one of three things, each taxed
        differently: <strong>remuneration</strong>, which is salary in the director&apos;s hands and
        carries TDS under s.192; a <strong>dividend</strong>, which is a distribution of
        already-taxed profit; or a <strong>loan</strong> through GL 2500 Director&apos;s Current
        Account, which s.185 limits and which has to come back. Switch to the personal account, or
        record what actually happened.
      </Alert>
    </div>
  )
}
