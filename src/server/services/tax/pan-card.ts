import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { isValidPanFormat, panEntity, panEntityLabel } from './pan'
import type { PartyKind } from './pan-register'

/**
 * PAN cards, held on file.
 *
 * 🔴 This system does not verify PANs online, and that is a decision rather than a gap.
 *
 * s.206AA turns on whether the payee **furnished** a PAN — not on anyone checking it against
 * a portal. So a format-valid number on file is already enough for the normal rate, and the
 * card copy is what the company holds to show it asked, and to resolve the one thing a
 * number alone cannot: whether the digits were transcribed correctly.
 *
 * What a card on file does NOT do is prove the PAN exists. Nothing available here can. A
 * wrong-but-well-formed PAN surfaces as a short-deduction notice on TRACES after the 26Q is
 * filed, and the card is the evidence that it was a transcription error rather than
 * indifference.
 */

/** Where a PAN card is filed. The attachment table is keyed by entity type and id. */
export const PAN_ENTITY: Record<PartyKind, string> = { EMPLOYEE: 'Employee', VENDOR: 'Vendor' }

export interface PanCardRow {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  uploadedAt: Date
}

export interface PanCardStatus {
  kind: PartyKind
  id: string
  name: string
  pan: string | null
  evidence: 'NONE' | 'DECLARED' | 'CARD_ON_FILE'
  evidenceAt: Date | null
  cards: PanCardRow[]
}

/**
 * The party, scoped to the caller's company.
 *
 * 🔴 In the same query that finds it. A PAN card is somebody's identity document, and the
 * upload route takes an entity id from the browser — looking the party up first is what
 * stops a card being filed against an id that is not ours to hold documents for.
 */
export async function assertParty(ctx: RequestContext, kind: PartyKind, id: string) {
  const row = kind === 'EMPLOYEE'
    ? await prisma.employee.findFirst({
        where: { id, companyId: ctx.companyId },
        select: { id: true, name: true, pan: true, panEvidence: true, panEvidenceAt: true },
      })
    : await prisma.vendor.findFirst({
        where: { id, companyId: ctx.companyId },
        select: { id: true, name: true, pan: true, panEvidence: true, panEvidenceAt: true },
      })
  if (!row) throw new NotFound(`${kind === 'EMPLOYEE' ? 'Employee' : 'Vendor'} not found`)
  return row
}

export async function panCards(ctx: RequestContext, kind: PartyKind, id: string): Promise<PanCardStatus> {
  assertCan(ctx.role, 'tax', 'read')
  const party = await assertParty(ctx, kind, id)
  const rows = await prisma.attachment.findMany({
    where: {
      companyId: ctx.companyId, kind: 'PAN_CARD',
      entityType: PAN_ENTITY[kind], entityId: id, detachedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  return {
    kind, id, name: party.name, pan: party.pan,
    evidence: party.panEvidence, evidenceAt: party.panEvidenceAt,
    cards: rows.map((r) => ({
      id: r.id, filename: r.filename, contentType: r.contentType,
      sizeBytes: r.sizeBytes, uploadedAt: r.createdAt,
    })),
  }
}

/** Every party that has a card on file, counted — the register asks this once for all rows. */
export async function panCardCounts(ctx: RequestContext): Promise<Map<string, number>> {
  const rows = await prisma.attachment.groupBy({
    by: ['entityType', 'entityId'],
    where: {
      companyId: ctx.companyId, kind: 'PAN_CARD', detachedAt: null,
      entityType: { in: ['Employee', 'Vendor'] },
    },
    _count: { _all: true },
  })
  return new Map(rows.map((r) => [`${r.entityType}:${r.entityId}`, r._count._all]))
}

/**
 * Confirm that the card on file is the PAN on file.
 *
 * A person does this, by looking at both. The system cannot: it has an image and a string,
 * and reading the one to check the other is exactly the kind of guess that puts a stranger's
 * PAN in a TDS return.
 *
 * So this records a human's confirmation, with their name and the time against it.
 */
export async function confirmPanCard(ctx: RequestContext, kind: PartyKind, id: string) {
  assertCan(ctx.role, 'tax', 'write')
  const party = await assertParty(ctx, kind, id)

  if (!party.pan) {
    throw new AppError(
      `${party.name} has no PAN recorded yet. Enter the number from the card first — the card on its own ` +
      'cannot be quoted in a return.',
    )
  }
  if (!isValidPanFormat(party.pan)) {
    throw new AppError(`"${party.pan}" is not a valid PAN, so there is nothing to confirm the card against`)
  }
  if (kind === 'EMPLOYEE' && panEntity(party.pan) !== 'INDIVIDUAL') {
    throw new AppError(
      `That PAN is a ${panEntityLabel(party.pan).toLowerCase()} — an employee's must be an individual's ` +
      '(4th character P). Check the card again.',
    )
  }

  const count = await prisma.attachment.count({
    where: {
      companyId: ctx.companyId, kind: 'PAN_CARD',
      entityType: PAN_ENTITY[kind], entityId: id, detachedAt: null,
    },
  })
  if (count === 0) {
    throw new AppError(
      `No copy of ${party.name}'s PAN card is attached. Upload it first — confirming without the card ` +
      'would record evidence that does not exist.',
    )
  }

  const data = {
    panEvidence: 'CARD_ON_FILE' as const,
    panEvidenceAt: new Date(),
    panEvidenceById: ctx.userId,
  }
  if (kind === 'EMPLOYEE') {
    await prisma.employee.update({ where: { id }, data })
  } else {
    // the number is what s.206AA turns on, and it is already on file — this only records
    // that the card behind it has been seen
    await prisma.vendor.update({ where: { id }, data: { ...data, panVerified: true } })
  }

  await audit(ctx, {
    entity: kind === 'EMPLOYEE' ? 'Employee' : 'Vendor', entityId: id, action: 'APPROVE',
    after: { panEvidence: 'CARD_ON_FILE', pan: party.pan, cards: count },
  })
  return { ok: true, name: party.name }
}

/**
 * Withdraw the confirmation.
 *
 * 🔴 Drops back to DECLARED, not to NONE, and leaves the file where it is. The payee did
 * furnish the number, so s.206AA is still satisfied and the rate must not change — this says
 * only that nobody now stands behind the comparison.
 */
export async function unconfirmPanCard(ctx: RequestContext, kind: PartyKind, id: string, reason: string) {
  assertCan(ctx.role, 'tax', 'write')
  if (reason.trim().length < 5) throw new AppError('Say why the confirmation is being withdrawn')
  const party = await assertParty(ctx, kind, id)

  const data = {
    panEvidence: (party.pan ? 'DECLARED' : 'NONE') as 'DECLARED' | 'NONE',
    panEvidenceAt: null,
    panEvidenceById: null,
  }
  if (kind === 'EMPLOYEE') await prisma.employee.update({ where: { id }, data })
  else await prisma.vendor.update({ where: { id }, data })

  await audit(ctx, {
    entity: kind === 'EMPLOYEE' ? 'Employee' : 'Vendor', entityId: id, action: 'UPDATE',
    before: { panEvidence: party.panEvidence }, after: { panEvidence: data.panEvidence, reason },
  })
  return { ok: true, note: 'The card is still on file — only the confirmation was withdrawn.' }
}
