'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { enqueue } from '@/lib/offline/queue'
import { useOffline } from '@/components/pwa/offline-provider'
import type { ExtractedReceipt } from '@/lib/receipt/extract'
import { Card, Button, Field, inputClass, inputStyle, Pill, Alert } from '@/components/ui/kit'

interface Category { id: string; name: string; code: string; itcDefault: string; gstTreatment: string }
interface Project { id: string; name: string }

export function CaptureFlow({ categories, projects }: { categories: Category[]; projects: Project[] }) {
  const router = useRouter()
  const { online, syncNow, refresh } = useOffline()
  const fileRef = useRef<HTMLInputElement>(null)

  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [ocr, setOcr] = useState<ExtractedReceipt | null>(null)
  const [ocrFailed, setOcrFailed] = useState(false)

  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [categoryId, setCategoryId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [description, setDescription] = useState('')
  const [gstRatePct, setGstRatePct] = useState('')
  const [saving, setSaving] = useState(false)
  const [queued, setQueued] = useState(false)

  const category = categories.find((c) => c.id === categoryId)
  const itcBlocked = category?.itcDefault === 'BLOCKED'

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhoto(file)
    setPreview(URL.createObjectURL(file))
    setOcr(null); setOcrFailed(false); setProgress(0); setReading(true)

    try {
      // loaded only now — the OCR engine is megabytes and most expenses are typed
      const { readReceipt } = await import('@/lib/receipt/ocr')
      const { fields } = await readReceipt(file, setProgress)
      setOcr(fields)
      // pre-fill, never auto-submit: OCR on a thermal receipt is wrong often enough
      if (fields.taxableValue) setAmount(fields.taxableValue)
      else if (fields.total) setAmount(fields.total)
      if (fields.date) setDate(fields.date)
      if (fields.gstRatePct) setGstRatePct(fields.gstRatePct)
      if (fields.vendorName) setDescription(fields.vendorName)
    } catch {
      setOcrFailed(true)
    } finally {
      setReading(false)
    }
  }

  async function submit() {
    if (!categoryId || !amount || !description) return
    setSaving(true)
    try {
      const item = await enqueue({
        categoryId, date, description,
        taxableValue: amount,
        gstRatePct: gstRatePct || undefined,
        projectId: projectId || undefined,
        itcEligible: itcBlocked ? false : undefined,
      }, photo ?? undefined)
      void item
      setQueued(true)
      await refresh()
      if (online) await syncNow()
      setTimeout(() => router.push('/expenses'), 900)
    } finally {
      setSaving(false)
    }
  }

  if (queued) {
    return (
      <Card className="p-6 text-center">
        <p className="text-[15px] font-semibold">Expense filed</p>
        <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {online ? 'Synced to the books.' : 'Queued — it will sync when you reconnect.'}
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <input ref={fileRef} type="file" accept="image/*" capture="environment"
          className="hidden" onChange={onPick} />

        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Receipt" className="mb-3 max-h-56 w-full rounded-lg object-contain"
            style={{ background: 'var(--surface)' }} />
        ) : null}

        <Button variant={preview ? 'ghost' : 'primary'} className="w-full"
          onClick={() => fileRef.current?.click()}>
          {preview ? 'Retake photo' : 'Photograph receipt'}
        </Button>

        {reading && (
          <p className="mt-2.5 text-center text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Reading receipt… {progress}%
          </p>
        )}

        {ocrFailed && (
          <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Could not read the photo — the receipt is still attached, just type the amount.
          </p>
        )}

        {ocr && !reading && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={ocr.confidence === 'high' ? 'good' : ocr.confidence === 'medium' ? 'warn' : 'critical'}>
              {ocr.confidence} confidence
            </Pill>
            {ocr.gstin && <Pill tone="neutral">GSTIN {ocr.gstin}</Pill>}
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Check every figure before filing.
            </span>
          </div>
        )}
      </Card>

      {ocr && ocr.candidateAmounts.length > 1 && (
        <Card className="p-4">
          <p className="eyebrow mb-2">Other amounts on the receipt</p>
          <div className="flex flex-wrap gap-2">
            {ocr.candidateAmounts.map((a) => (
              <button key={a} onClick={() => setAmount(a)}
                className="rounded-lg border px-2.5 py-1 text-[12.5px] tabular"
                style={{ borderColor: amount === a ? 'var(--accent)' : 'var(--rule)' }}>
                ₹{a}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card className="space-y-3.5 p-4">
        <Field label="Amount before GST">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className={inputClass} style={inputStyle} />
        </Field>

        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass} style={inputStyle}>
            <option value="">Choose…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        {projects.length > 0 && (
          <Field label="Project" hint="Optional — this is what makes project margin real">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
              className={inputClass} style={inputStyle}>
              <option value="">None</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="What was it for">
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Taxi to client meeting" className={inputClass} style={inputStyle} />
        </Field>
      </Card>

      {itcBlocked && (
        <Alert tone="warn" title="Input credit is blocked for this category">
          Section 17(5) blocks the credit on {category?.name.toLowerCase()}. The expense will be
          filed with the GST as cost, not as a claim.
        </Alert>
      )}

      {!online && (
        <Alert tone="info" title="You are offline">
          File it anyway — it is stored on this device and syncs by itself when you reconnect.
        </Alert>
      )}

      <Button className="w-full" onClick={() => void submit()}
        disabled={saving || !categoryId || !amount || !description}>
        {saving ? 'Filing…' : online ? 'File expense' : 'Queue expense'}
      </Button>
    </div>
  )
}
