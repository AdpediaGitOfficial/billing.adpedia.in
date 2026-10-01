import { requireContext } from '@/server/context'
import { readAttachment, detachAttachment, safeDownloadHeaders } from '@/server/services/storage/attachment'
import { AppError } from '@/server/errors'
import { handler } from '@/app/api/_lib/handler'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext()
    const { id } = await params
    const { row, bytes } = await readAttachment(ctx, id)
    return new Response(new Uint8Array(bytes), {
      headers: safeDownloadHeaders(row.contentType, row.filename),
    })
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500
    return new Response(e instanceof AppError ? e.message : 'Could not read that file', { status })
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
