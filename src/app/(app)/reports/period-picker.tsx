'use client'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

/** Shared across every statement so a chosen year follows you between reports. */
export function PeriodPicker({ options, value }: { options: { id: string; label: string }[]; value: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  if (options.length <= 1) return null

  return (
    <select
      value={value}
      onChange={(e) => {
        const next = new URLSearchParams(params)
        next.set('fy', e.target.value)
        router.push(`${pathname}?${next}`)
      }}
      className="rounded-lg border px-3 py-1.5 text-[13px] font-medium"
      style={{ borderColor: 'var(--rule)', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
      aria-label="Financial year"
    >
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}
