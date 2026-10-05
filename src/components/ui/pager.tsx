import Link from 'next/link'
import { pageHref, type Page } from '@/lib/paging'
import { Icon } from '@/components/shell/icon'

/**
 * The pagination control — docs/78.
 *
 * 🔴 One component, because four hand-written pagers are four places for an off-by-one, and
 * because what a reader needs is the same on every list: which rows these are, out of how many.
 * "51–100 of 247" answers a question "Page 2 of 5" does not — whether the thing they are
 * looking for is behind them or ahead.
 */
export function Pager({ page, basePath, params, noun = 'rows' }: {
  page: Page
  basePath: string
  params: Record<string, string | undefined>
  noun?: string
}) {
  // 🔴 Nothing at all for a single page. A pager over eleven invoices is noise that teaches
  // somebody to stop looking at the bottom of the list.
  if (page.pages <= 1) return null

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[12.5px]"
         style={{ borderTop: '1px solid var(--rule)' }} aria-label="Pagination">
      <span style={{ color: 'var(--text-muted)' }} className="tabular">
        {page.from}–{page.to} of {page.total} {noun}
      </span>
      <span className="flex items-center gap-2">
        <Step href={pageHref(basePath, params, page.page - 1)} enabled={page.hasPrevious} icon="ChevronLeft" label="Previous" />
        <span className="tabular" style={{ color: 'var(--text-muted)' }}>{page.page} / {page.pages}</span>
        <Step href={pageHref(basePath, params, page.page + 1)} enabled={page.hasNext} icon="ChevronRight" label="Next" trailing />
      </span>
    </nav>
  )
}

function Step({ href, enabled, icon, label, trailing }: {
  href: string; enabled: boolean; icon: 'ChevronLeft' | 'ChevronRight'; label: string; trailing?: boolean
}) {
  const inner = (
    <span className="flex items-center gap-1">
      {!trailing && <Icon name={icon} size={14} strokeWidth={2.2} />}
      {label}
      {trailing && <Icon name={icon} size={14} strokeWidth={2.2} />}
    </span>
  )
  // 🔴 A disabled step is not a link. Rendering one that goes nowhere is a control that lies
  // about being usable, and on a phone it is a 44px target that does nothing.
  if (!enabled) {
    return <span className="rounded-lg border px-3 py-1.5 font-medium"
      style={{ borderColor: 'var(--rule)', color: 'var(--text-muted)', opacity: 0.55 }}>{inner}</span>
  }
  return (
    <Link href={href} className="rounded-lg border px-3 py-1.5 font-medium"
      style={{ borderColor: 'var(--rule)' }}>{inner}</Link>
  )
}
