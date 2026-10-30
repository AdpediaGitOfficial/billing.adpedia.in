import type { Role } from '@prisma/client'

/**
 * Which entity a session is in — docs/82 §3.
 *
 * 🔴 This replaces `user.companies[0]`, which appeared in BOTH `login` and the refresh path.
 * `include: { companies: true }` has no `orderBy`, so the "first" membership is whatever
 * Postgres finds convenient, and what is convenient changes as rows are written — docs/80 §5's
 * defect class exactly, and docs/78 §1's before it.
 *
 * With one membership that is invisible. With two it is two separate failures:
 *
 *   · on LOGIN, you land in whichever entity the database felt like
 *   · on REFRESH, fifteen minutes into drafting an invoice, the entity can CHANGE under you —
 *     and the invoice posts to the other company's books, numbered from its series, frozen on
 *     send. There is no undo for that, only a cancellation that keeps the number.
 *
 * So the choice is made here, explicitly, from a recorded preference and a total order.
 */

export interface Membership {
  companyId: string
  role: Role
  company?: { legalName: string } | null
}

/**
 * The entity to open, or null when this account belongs to none.
 *
 * `preferredCompanyId` is `User.lastCompanyId` — where the session was. It is honoured only
 * when it is still a membership, so losing access (docs/77) degrades to the fallback instead
 * of locking somebody out of the app entirely.
 */
export function chooseCompany<T extends Membership>(
  memberships: readonly T[],
  preferredCompanyId?: string | null,
): T | null {
  if (memberships.length === 0) return null

  if (preferredCompanyId) {
    const preferred = memberships.find((m) => m.companyId === preferredCompanyId)
    if (preferred) return preferred
  }

  // 🔴 A TOTAL order, not "the first row". Legal name is what a person would expect; the id
  // breaks ties, so two entities with the same name still resolve the same way every time —
  // the same reasoning as the `id` tiebreaker on the ledger's ordering (docs/58 §4).
  return [...memberships].sort((a, b) => {
    const nameA = a.company?.legalName
    const nameB = b.company?.legalName
    // An entity we can NAME comes before one we cannot. Comparing `?? ''` instead put the
    // unnamed one first, because the empty string sorts before everything — so a caller that
    // forgot to join the company would have picked the entity it knew least about.
    if (nameA && nameB) {
      const byName = nameA.localeCompare(nameB)
      if (byName !== 0) return byName
    } else if (nameA) return -1
    else if (nameB) return 1

    return a.companyId.localeCompare(b.companyId)
  })[0]
}
