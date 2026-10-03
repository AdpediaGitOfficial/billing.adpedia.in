import { Button } from '@/components/ui/kit'

/**
 * A plain anchor, not a fetch. The browser's own download handling is better than anything
 * we would write — it shows progress, it survives a navigation, and the Content-Disposition
 * filename arrives intact.
 */
export function ExportButton({ report, fy, account, label = 'Export CSV' }: {
  report: string; fy?: string; account?: string; label?: string
}) {
  const href = `/api/reports/export?report=${report}${fy ? `&fy=${fy}` : ''}${account ? `&account=${account}` : ''}`
  return (
    <a href={href} download>
      <Button variant="ghost" size="sm">{label}</Button>
    </a>
  )
}

/**
 * The same statement as a PDF — docs/58.
 *
 * 🔴 Opened, not downloaded. The CSV is a file somebody works on; the PDF is a document
 * somebody reads, and forcing it into the downloads folder adds a step before they can.
 */
export function StatementPdfButton({ statement, fy, label = 'PDF' }: {
  statement: 'pnl' | 'balance-sheet' | 'trial-balance'; fy?: string; label?: string
}) {
  const href = `/api/reports/document?statement=${statement}${fy ? `&fy=${fy}` : ''}`
  return (
    <a href={href} target="_blank" rel="noreferrer">
      <Button variant="ghost" size="sm" icon="FileText">{label}</Button>
    </a>
  )
}
