import { requireContext } from '@/server/context'
import { readAttachment, detachAttachment, safeDownloadHeaders } from '@/server/services/storage/attachment'
import { handler, fileError } from '@/app/api/_lib/handler'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    const { id } = await params
    const { row, bytes } = await readAttachment(ctx, id)
    return new Response(new Uint8Array(bytes), {
      headers: safeDownloadHeaders(row.contentType, row.filename),
    })
  } catch (e) {
    // 🔴 docs/80 — the cause is logged, the message stays generic. See `_lib/handler.ts`.
    return fileError(e, 'attachments/[id]', 'Could not read that file')
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const ctx = await requireContext()
    const { id } = await params
    const reason = new URL(req.url).searchParams.get('reason') ?? undefined
    return detachAttachment(ctx, id, reason)
  })
}

export const runtime = 'nodejs'
