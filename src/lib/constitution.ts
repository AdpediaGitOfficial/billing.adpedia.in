import type { Constitution } from '@prisma/client'

/**
 * What each constitution is CALLED on screen — docs/88.
 *
 * 🔴 The stored value stays `PROPRIETORSHIP`. The chart of accounts (Proprietor's Capital and
 * Drawings), the PAN-type check, whose income-tax return it is and whether the categories
 * deduct TDS all key off it. Renaming the value would rename none of those, only break them.
 * What a person recognises it as is a label, and a label lives here, once.
 *
 * "Personal account" is how this entity is used: one person's own freelance income, projects
 * and invoices, with no GST registration and none of a company's filings.
 */
export const CONSTITUTION_LABEL: Record<Constitution, string> = {
  PROPRIETORSHIP: 'Personal account',
  PRIVATE_LIMITED: 'Private limited',
  LLP: 'LLP',
  PARTNERSHIP: 'Partnership',
  PUBLIC_LIMITED: 'Public limited',
}

/** The order a form offers them in: the personal account first, then the legal entities. */
export const CONSTITUTION_ORDER: readonly Constitution[] = [
  'PROPRIETORSHIP', 'PRIVATE_LIMITED', 'LLP', 'PARTNERSHIP', 'PUBLIC_LIMITED',
]
