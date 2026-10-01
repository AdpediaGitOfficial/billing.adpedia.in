'use client'
import { useRef, useState } from 'react'
import { Card, Button, Pill } from '@/components/ui/kit'

export interface AttachmentRow {
  id: string; filename: string; contentType: string; sizeBytes: number
}

const size = (n: number) => n < 1024 * 1024
  ? `${Math.round(n / 1024)} KB`
  : `${(n / 1024 / 1024).toFixed(1)} MB`

/**
 * Attach and list files against a record.
 *
 * 🔴 Every link is a download, never a preview. The server refuses to serve anything inline,
 * so an `<img>` or an iframe pointed at one would simply fail — and the reason it refuses is
 * that a user-uploaded file rendering in this origin is exactly how stored XSS works.
 */
export function AttachmentPanel({ entityType, entityId, kind, initial, title = 'Attachments', hint }: {
  entityType: string; entityId: string; kind: string
  initial: AttachmentRow[]
  title?: string
  hint?: string
}) {
  const [rows, setRows] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', kind)
      form.append('entityType', entityType)
      form.append('entityId', entityId)

      const res = await fetch('/api/attachments', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? 'Could not store that file')

      setRows((r) => [body as AttachmentRow, ...r.filter((x) => x.id !== body.id)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not store that file')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function detach(id: string) {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Could not detach that file')
      setRows((r) => r.filter((x) => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not detach that file')
    } finally { setBusy(false) }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] font-semibold">{title}</p>
        <input ref={fileRef} type="file" className="hidden"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Working…' : 'Attach a file'}
        </Button>
      </div>

      {hint && <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{hint}</p>}

      {error && (
        <p className="mt-2 rounded-lg px-3 py-2 text-[11.5px]"
          style={{ background: 'var(--surface)', color: 'var(--critical)' }}>{error}</p>
      )}

      {rows.length === 0 ? (
        <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          Nothing attached. A photo or PDF of the bill is what substantiates the claim if it is
          ever asked for.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-1.5">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
              style={{ background: 'var(--surface)' }}>
              <span className="min-w-0">
                <a href={`/api/attachments/${a.id}`} download className="text-[12.5px] font-medium hover:underline">
                  {a.filename}
                </a>
                <span className="ml-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{size(a.sizeBytes)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Pill tone="neutral">{a.contentType.split('/')[1]}</Pill>
                <button type="button" onClick={() => void detach(a.id)} disabled={busy}
                  className="text-[11.5px] underline" style={{ color: 'var(--text-muted)' }}>
                  detach
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
