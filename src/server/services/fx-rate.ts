import { Decimal } from '@/lib/money'
import { AppError } from '@/server/errors'
import { isForeign, parseFxRate } from '@/lib/fx'

/**
 * docs/91 — the rate this document is booked at. Rupees need none. A foreign document keeps
 * the rate it already had unless a new one is typed, and a rate that is typed but not a
 * positive number is refused rather than quietly dropped back to the "not entered" 1.
 */
export function documentFxRate(currency: string, raw: string | undefined, existing?: Decimal.Value | null): Decimal {
  if (!isForeign(currency)) return new Decimal(1)
  if (raw != null && raw.trim() !== '') {
    const r = parseFxRate(raw)
    if (!r) throw new AppError('The exchange rate must be a positive number — rupees per one unit of the invoice currency, up to 6 decimals.')
    return r
  }
  return existing != null ? new Decimal(existing) : new Decimal(1)
}
