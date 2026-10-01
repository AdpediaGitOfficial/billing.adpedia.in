import { Button } from '@/components/ui/kit'

/**
 * A plain anchor, not a fetch. The browser's own download handling is better than anything
 * we would write — it shows progress, it survives a navigation, and the Content-Disposition
 * filename arrives intact.
 */
export function ExportButton({ report, fy, label = 'Export CSV' }: {
  report: string; fy?: string; label?: string
}) {
  const href = `/api/reports/export?report=${report}${fy ? `&fy=${fy}` : ''}`
  return (
    <a href={href} download>
      <Button variant="ghost" size="sm">{label}</Button>
    </a>
  )
}
