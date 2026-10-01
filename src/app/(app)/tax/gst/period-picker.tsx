'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Segmented } from '@/components/ui/kit'

export function PeriodPicker({ periods, selected }: { periods: { label: string; title: string }[]; selected: string }) {
  const router = useRouter()
  const sp = useSearchParams()

  if (periods.length <= 1) {
    return <p className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>{periods[0]?.title ?? ''}</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        options={periods.map((p) => ({ value: p.label, label: p.title }))}
        value={selected}
        onChange={(v) => {
          const next = new URLSearchParams(sp.toString())
          next.set('period', v)
          router.push(`/tax/gst?${next.toString()}`)
        }}
      />
    </div>
  )
}
