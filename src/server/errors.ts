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
/** Too many failed sign-ins — docs/95. `retryAfterSeconds` becomes the Retry-After header. */
export class TooManyAttempts extends AppError {
  constructor(m: string, readonly retryAfterSeconds: number) { super(m, 429, 'TOO_MANY_ATTEMPTS') }
}
/** Posting into a locked or closed period. Corrections go in an open period as reversals. */
export class PeriodLocked extends AppError {
  constructor(m: string) { super(m, 409, 'PERIOD_LOCKED') }
}
/** A journal entry whose debits and credits disagree. Should never reach the database. */
export class UnbalancedJournal extends AppError {
  constructor(m: string) { super(m, 500, 'UNBALANCED_JOURNAL') }
}

/**
 * The PDF renderer cannot run on this server — docs/85.
 *
 * 🔴 Not a 500, and not a generic one. Every other unexpected failure in a file route is
 * deliberately shown as a flat sentence with the cause sent to the log (docs/80), because a
 * raw error carries table and column names. A Chromium that will not start carries none of
 * that: the cause is the box, the fix is two commands in docs/90 Step 10, and the person
 * reading the screen is the only one who can apply it. Saying "Could not render the invoice"
 * to them is withholding the one fact they need.
 */
export class RendererUnavailable extends AppError {
  constructor(m: string) { super(m, 503, 'RENDERER_UNAVAILABLE') }
}
