import { prisma } from '@/server/db'
import type { RequestContext } from '@/server/context'
import { assertCan } from '@/server/auth/permissions'
import { audit } from '@/server/audit'
import { AppError, NotFound } from '@/server/errors'
import { storage, newStorageKey, sha256 } from './driver'
import type { AttachmentKind } from '@prisma/client'

/** A receipt photo off a phone is routinely 3–6 MB; a scanned bill PDF rarely more. */
export const MAX_BYTES = 12 * 1024 * 1024

/**
 * 🔴 The allowlist is of what we will SERVE, not of what someone might send.
 *
 * Two things are deliberately absent:
 *
 * **SVG.** It is an image by every ordinary definition and it can contain `<script>`.
 * Served from this origin it runs with the signed-in user's session — stored XSS, from a
 * file an employee uploaded as a "receipt".
 *
 * **HTML.** Same reasoning, less disguise.
 *
 * HEIC is accepted because that is what an iPhone produces by default, and refusing it
 * would mean half the receipts simply fail.
 */
const ALLOWED: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png':  { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  'image/heic': { ext: 'heic', magic: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' },
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  'text/csv':   { ext: 'csv', magic: () => true },   // no magic number exists for CSV
  'text/plain': { ext: 'txt', magic: () => true },
}

export interface UploadInput {
  kind: AttachmentKind
  entityType: string
  entityId: string
  filename: string
  contentType: string
  bytes: Buffer
}

/**
 * Store a file against a record.
 *
 * 🔴 The declared content-type is checked against the file's actual MAGIC BYTES. A client
 * controls the `Content-Type` header completely, so a file claiming `image/png` that is in
 * fact HTML would otherwise be stored as an image and — if anything ever served it inline —
 * execute. Checking the bytes makes the declaration irrelevant.
 */
export async function uploadAttachment(ctx: RequestContext, input: UploadInput) {
  assertCan(ctx.role, 'expenses.own', 'write')

  if (input.bytes.length === 0) throw new AppError('That file is empty')
  if (input.bytes.length > MAX_BYTES) {
    throw new AppError(`That file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_BYTES / 1024 / 1024} MB`)
  }

  const allowed = ALLOWED[input.contentType]
  if (!allowed) {
    throw new AppError(
      `${input.contentType} cannot be stored. Receipts and bills should be a photo (JPEG, PNG, HEIC, WebP) or a PDF.`,
    )
  }
  if (!allowed.magic(input.bytes)) {
    throw new AppError(
      `That file says it is ${input.contentType} but its contents are not. Re-export it and try again.`,
    )
  }

  const hash = sha256(input.bytes)

  // the same receipt photographed twice, or a retried upload, reuses the stored object
  const existing = await prisma.attachment.findFirst({
    where: { companyId: ctx.companyId, sha256: hash, entityType: input.entityType, entityId: input.entityId },
  })
  if (existing) return existing

  const key = newStorageKey(ctx.companyId, input.contentType)
  await storage().put(key, input.bytes, input.contentType)

  const row = await prisma.attachment.create({
    data: {
      companyId: ctx.companyId, kind: input.kind,
      entityType: input.entityType, entityId: input.entityId,
      // kept purely as a label; it never touches the storage path
      filename: safeLabel(input.filename, allowed.ext),
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
      sha256: hash, storageKey: key, uploadedById: ctx.userId,
    },
  })

  await audit(ctx, { entity: 'Attachment', entityId: row.id, action: 'CREATE',
    after: { kind: input.kind, entityType: input.entityType, entityId: input.entityId, sizeBytes: row.sizeBytes } })
  return row
}

/**
 * The display name.
 *
 * Stripped of anything that could matter if it were ever interpreted as a path, and of
 * control characters — including the RTL override used to disguise `receipt<U+202E>gpj.exe`
 * as `receipt.jpg`.
 */
function safeLabel(name: string, ext: string): string {
  const base = (name.split(/[/\\]/).pop() ?? 'file')
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 120)
    .trim()
  const safe = base.replace(/^\.+/, '') || 'file'
  return safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
}

export async function listAttachments(ctx: RequestContext, entityType: string, entityId: string) {
  assertCan(ctx.role, 'expenses.own', 'read')
  return prisma.attachment.findMany({
    where: { companyId: ctx.companyId, entityType, entityId, detachedAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Fetch a stored file.
 *
 * 🔴 Scoped to the caller's company in the SAME query that finds it. Looking it up by id and
 * then comparing companyId afterwards is the same thing until somebody edits one of the two
 * lines; keeping it in the `where` makes a cross-company read impossible rather than merely
 * guarded against.
 */
export async function readAttachment(ctx: RequestContext, id: string) {
  assertCan(ctx.role, 'expenses.own', 'read')
  const row = await prisma.attachment.findFirst({ where: { id, companyId: ctx.companyId } })
  if (!row) throw new NotFound('Attachment not found')
  return { row, bytes: await storage().get(row.storageKey) }
}

/**
 * Detach a file — hide it, keep it.
 *
 * 🔴 Not a delete. A receipt is the evidence behind an input-credit claim, and a bill PDF is
 * what substantiates a deduction; destroying either could remove the proof needed to sustain
 * the claim years later, when it is actually asked for. This matches the rest of the system,
 * where a wrong invoice is cancelled and reversed rather than erased.
 *
 * The stored object is deliberately left in place.
 */
export async function detachAttachment(ctx: RequestContext, id: string, reason?: string) {
  assertCan(ctx.role, 'expenses.all', 'write')
  const row = await prisma.attachment.findFirst({ where: { id, companyId: ctx.companyId, detachedAt: null } })
  if (!row) throw new NotFound('Attachment not found')

  await prisma.attachment.update({ where: { id: row.id }, data: { detachedAt: new Date() } })
  await audit(ctx, { entity: 'Attachment', entityId: id, action: 'CANCEL',
    before: { filename: row.filename }, after: { reason: reason ?? null } })
  return { ok: true }
}

/** Headers that make serving a user-uploaded file safe. */
export function safeDownloadHeaders(contentType: string, filename: string): HeadersInit {
  return {
    'content-type': contentType,
    // 🔴 attachment, never inline — nothing a user uploaded renders in this origin
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    // 🔴 stops the browser second-guessing the type and running it as something else
    'x-content-type-options': 'nosniff',
    // 🔴 belt and braces: even if it were rendered, nothing in it may execute or load
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  }
}
