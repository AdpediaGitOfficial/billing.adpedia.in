import { formatINR, formatCompactINR } from '@/lib/money'

/**
 * Charts are client components rendered from server components, so a formatter
 * cannot be passed as a function prop — functions are not serialisable across the
 * RSC boundary. Callers pass a token and the chart resolves it on the client.
 */
export type ValueFormat = 'inr' | 'inr-compact' | 'inr-whole' | 'number'

export function formatBy(format: ValueFormat, n: number): string {
  switch (format) {
    case 'inr': return formatINR(n)
    case 'inr-whole': return formatINR(n, { decimals: false })
    case 'inr-compact': return formatCompactINR(n)
    case 'number': return new Intl.NumberFormat('en-IN').format(n)
  }
}
