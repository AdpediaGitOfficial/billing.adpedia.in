'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/kit'

/**
 * Share an invoice the way it actually gets sent in India: WhatsApp.
 *
 * The Web Share API hands the PDF to whatever the person picks, so the file goes
 * directly — no link that expires, no login wall for the client, no email that lands in
 * promotions. Where file sharing is unsupported (most desktop browsers) it falls back to
 * sharing the link, and failing that, to a plain download.
 */
export function ShareInvoice({ invoiceId, number, customerName, total }: {
  invoiceId: string; number: string; customerName: string; total: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const text = `Invoice ${number} from Adpedia Films Pvt Ltd for ${customerName} — ${total}.`

  async function share() {
    setBusy(true); setNote(null)
    const url = `${location.origin}/api/invoices/${invoiceId}/document`

    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('Could not fetch the document')
      const blob = await res.blob()
      // 🔴 Name the file after what it ACTUALLY is. The document route serves HTML until
      // the Playwright PDF worker lands (docs/21 §6), so hard-coding ".pdf" would hand the
      // client a file whose extension lies about its contents — WhatsApp shows it as a
      // broken PDF, and the invoice looks unprofessional at exactly the wrong moment.
      const type = blob.type || 'application/octet-stream'
      const ext = type.includes('pdf') ? 'pdf' : type.includes('html') ? 'html' : 'bin'
      const file = new File([blob], `${number.replace(/\//g, '-')}.${ext}`, { type })

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice ${number}`, text })
        return
      }
      if (navigator.share) {
        await navigator.share({ title: `Invoice ${number}`, text, url })
        return
      }

      // no Web Share at all — download it so the person can attach it themselves
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href; a.download = file.name; a.click()
      URL.revokeObjectURL(href)
      setNote('Downloaded — attach it from your files.')
    } catch (e) {
      // the user dismissing the share sheet throws AbortError; that is not an error
      if (e instanceof DOMException && e.name === 'AbortError') return
      setNote(e instanceof Error ? e.message : 'Could not share')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Button variant="ghost" onClick={() => void share()} disabled={busy}>
        {busy ? 'Preparing…' : 'Share'}
      </Button>
      {note && <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{note}</p>}
    </div>
  )
}
