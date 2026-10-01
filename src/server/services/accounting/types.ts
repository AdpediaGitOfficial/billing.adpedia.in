import type { Decimal } from '@/lib/money'
import type { SourceType } from '@prisma/client'

/** One side of a journal entry. Produced by pure posting rules — no I/O. */
export interface Posting {
  accountCode: string
  debit?: Decimal
  credit?: Decimal
  narration?: string
  // analytical dimensions — what makes project and client P&L a query, not a second ledger
  projectId?: string
  customerId?: string
  vendorId?: string
  employeeId?: string
}

export interface JournalDraft {
  date: Date
  narration: string
  sourceType: SourceType
  sourceId?: string
  postings: Posting[]
}

/** A posting rule is a pure function. This is what makes it property-testable. */
export type PostingRule<T, C> = (doc: T, cfg: C) => Posting[]
