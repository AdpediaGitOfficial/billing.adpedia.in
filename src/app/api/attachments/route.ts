import { handler } from '@/app/api/_lib/handler'
import { requireContext } from '@/server/context'
import { uploadAttachment, MAX_BYTES } from '@/server/services/storage/attachment'
import { AppError } from '@/server/errors'
import type { AttachmentKind } from '@prisma/client'

const KINDS = ['RECEIPT', 'VENDOR_INVOICE', 'PAYSLIP', 'FORM_26AS', 'CHALLAN', 'BANK_STATEMENT', 'OTHER']

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
