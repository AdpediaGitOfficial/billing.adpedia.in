import { prisma } from '@/server/db'
import { TooManyAttempts } from '@/server/errors'

/**
 * Failed-password throttling — docs/95.
 *
 * 🔴 `/api/auth/login` had no limit of any kind: argon2id makes each guess cost about 50 ms,
 * which slows a brute force without stopping one. Eight failures inside fifteen minutes now lock
 * the address for fifteen minutes.
 *
 * Decisions, each of which was a choice:
 *
 * - **Keyed by email, not by IP.** `clientMeta()` takes the FIRST `x-forwarded-for` entry, which
 *   behind nginx's `$proxy_add_x_forwarded_for` is whatever the client chose to send — an IP key
 *   would be defeated by one header. An email key cannot be rotated around.
 * - **Keyed whether or not the email is an account.** A throttle that only counted real users
 *   would answer "locked" for exactly the addresses that exist.
 * - **A lock refuses the CORRECT password too.** Otherwise the lock is only a delay to the
 *   guesser who keeps going.
 * - **The cost is a denial of service on one account**: anyone who knows the owner's address can
 *   keep it locked. That lasts fifteen minutes at a time, clears itself, and a passkey session
 *   already signed in is unaffected. It was judged better than an unthrottled password.
 * - The count is one atomic upsert, so eight parallel guesses cannot all read "seven".
 */
export const MAX_FAILURES = 8
export const WINDOW_MS = 15 * 60_000
export const LOCK_MS = 15 * 60_000

export const throttleKey = (email: string) => email.toLowerCase().trim().slice(0, 254)

/** Throws TooManyAttempts when this address is locked. Called BEFORE the password is checked. */
export async function assertNotLocked(email: string, now = new Date()) {
  const row = await prisma.loginThrottle.findUnique({ where: { key: throttleKey(email) } })
  if (row?.lockedUntil && row.lockedUntil > now) {
    const seconds = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000)
    throw new TooManyAttempts(
      `Too many failed sign-in attempts. Try again in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}.`,
      seconds,
    )
  }
}

/** Count one failure; the eighth in a window sets the lock. */
export async function recordFailure(email: string, now = new Date()) {
  const key = throttleKey(email)
  const windowStart = new Date(now.getTime() - WINDOW_MS)
  const lockUntil = new Date(now.getTime() + LOCK_MS)
  await prisma.$executeRaw`
    INSERT INTO "LoginThrottle" ("key", "failures", "windowStart", "lockedUntil", "updatedAt")
    VALUES (${key}, 1, ${now}, NULL, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "failures"    = CASE WHEN "LoginThrottle"."windowStart" < ${windowStart} THEN 1 ELSE "LoginThrottle"."failures" + 1 END,
      "windowStart" = CASE WHEN "LoginThrottle"."windowStart" < ${windowStart} THEN ${now} ELSE "LoginThrottle"."windowStart" END,
      "lockedUntil" = CASE
        WHEN "LoginThrottle"."windowStart" < ${windowStart} THEN NULL
        WHEN "LoginThrottle"."failures" + 1 >= ${MAX_FAILURES} THEN ${lockUntil}
        ELSE "LoginThrottle"."lockedUntil" END,
      "updatedAt"   = ${now}`
  // keeps the table to the addresses that failed recently; indexed on updatedAt
  await prisma.loginThrottle.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } })
}

/** A good sign-in forgets the failures that led up to it. */
export async function clearFailures(email: string) {
  await prisma.loginThrottle.deleteMany({ where: { key: throttleKey(email) } })
}
