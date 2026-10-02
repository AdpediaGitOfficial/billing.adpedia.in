import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { uploadAttachment, MAX_BYTES } from '@/server/services/storage/attachment'
import { AppError } from '@/server/errors'
import { assertParty, PAN_ENTITY } from '@/server/services/tax/pan-card'
import { prisma } from '@/server/db'
import type { AttachmentKind } from '@prisma/client'

const KINDS = ['RECEIPT', 'VENDOR_INVOICE', 'PAYSLIP', 'FORM_26AS', 'CHALLAN', 'BANK_STATEMENT', 'PAN_CARD', 'TDS_CERTIFICATE', 'OTHER']

export async function POST(req: Request) {
  return handler(async () => {
    const ctx = await requireContext()
    const form = await req.formData()

    const file = form.get('file')
    if (!(file instanceof File)) throw new AppError('No file was sent')
    if (file.size > MAX_BYTES) {
      throw new AppError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_BYTES / 1024 / 1024} MB`)
    }

    const kind = String(form.get('kind') ?? 'OTHER')
    if (!KINDS.includes(kind)) throw new AppError(`Unknown attachment kind "${kind}"`)

    const entityType = String(form.get('entityType') ?? '')
    const entityId = String(form.get('entityId') ?? '')
    if (!entityType || !entityId) throw new AppError('An attachment needs something to attach to')

    // 🔴 A PAN card is somebody's identity document, and the id comes from the browser. The
    // party is looked up in this company before the file is stored, so a card cannot be
    // filed against an id that is not ours to hold documents for.
    if (kind === 'PAN_CARD') {
      const party = entityType === PAN_ENTITY.EMPLOYEE ? 'EMPLOYEE'
        : entityType === PAN_ENTITY.VENDOR ? 'VENDOR'
        : null
      if (!party) throw new AppError('A PAN card belongs to an employee or a vendor')
      await assertParty(ctx, party, entityId)
    }

    // 🔴 Same reasoning for a TDS certificate — it names a person and their PAN, so it is
    // filed against a certificate record that belongs to this company or not at all.
    if (kind === 'TDS_CERTIFICATE') {
      if (entityType !== 'TdsCertificate') throw new AppError('A TDS certificate belongs to a certificate record')
      const exists = await prisma.tdsCertificate.count({ where: { id: entityId, companyId: ctx.companyId } })
      if (exists === 0) throw new AppError('Certificate record not found')
    }

    const row = await uploadAttachment(ctx, {
      kind: kind as AttachmentKind,
      entityType, entityId,
      filename: file.name || 'upload',
      // 🔴 taken as a CLAIM only — uploadAttachment checks it against the magic bytes
      contentType: file.type || 'application/octet-stream',
      bytes: Buffer.from(await file.arrayBuffer()),
    })

    return { id: row.id, filename: row.filename, sizeBytes: row.sizeBytes, contentType: row.contentType }
  })
}

export const runtime = 'nodejs'
