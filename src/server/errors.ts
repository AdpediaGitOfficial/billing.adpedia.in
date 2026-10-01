export class AppError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'BAD_REQUEST') {
    super(message)
    this.name = new.target.name
  }
}

export class Unauthorized extends AppError {
  constructor(m = 'Not authenticated') { super(m, 401, 'UNAUTHORIZED') }
}
export class Forbidden extends AppError {
  constructor(m = 'Not permitted') { super(m, 403, 'FORBIDDEN') }
}
export class NotFound extends AppError {
  constructor(m = 'Not found') { super(m, 404, 'NOT_FOUND') }
}
/** Posting into a locked or closed period. Corrections go in an open period as reversals. */
export class PeriodLocked extends AppError {
  constructor(m: string) { super(m, 409, 'PERIOD_LOCKED') }
}
/** A journal entry whose debits and credits disagree. Should never reach the database. */
export class UnbalancedJournal extends AppError {
  constructor(m: string) { super(m, 500, 'UNBALANCED_JOURNAL') }
}
