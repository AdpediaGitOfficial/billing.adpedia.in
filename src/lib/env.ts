import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),        // 15 min
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),   // 30 days
  /**
   * 🔴 docs/83 — how long the privacy screen waits, in minutes. Five was too short to work
   * with: it is drawn over a session that is still valid, so the only thing it achieved at
   * five minutes was a passkey prompt in the middle of entering a bill. Read on the SERVER and
   * passed to the component as a prop, deliberately not NEXT_PUBLIC_ — that would be inlined
   * at build time (docs/90) and could not be changed without rebuilding.
   */
  IDLE_LOCK_MINUTES: z.coerce.number().int().min(1).default(30),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // 🔴 docs/95 — everything below used to be read straight from `process.env` at the call site,
  // so a typo (`WEBAUTHN_ORIGIN=localhost:3000`, `CRON_SECRET` too short) surfaced as a failure
  // in whatever feature touched it first — a passkey prompt that would not verify, a scheduler
  // that answered 503 — rather than as a refusal to start. They are all optional and all have a
  // safe default at the point of use; what is validated here is that a value which IS set is
  // one the feature can work with. The runtime reads stay where they are (several tests flip
  // FX_LIVE_RATES and EINVOICE_ENABLED between cases, which a cached value would ignore).
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters (openssl rand -hex 24)').optional(),
  // `new URL('localhost:3000')` is VALID — scheme "localhost:" — so .url() alone passes the one typo this exists to catch
  WEBAUTHN_ORIGIN: z.string().regex(/^https?:\/\/[^/\s]+$/, 'WEBAUTHN_ORIGIN must be an origin such as https://billing.adpedia.in — scheme and host, no path').optional(),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, 'VAPID_SUBJECT must be a mailto: or https:// address').optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
  STORAGE_DIR: z.string().min(1).optional(),
  FX_LIVE_RATES: z.enum(['on', 'off']).optional(),
  IRP_MODE: z.enum(['mock', 'live']).optional(),
  EINVOICE_ENABLED: z.enum(['true', 'false']).optional(),
})
.superRefine((v, ctx) => {
  // a half-configured push pair fails at send time, per recipient, with nothing pointing at the cause
  if (Boolean(v.VAPID_PUBLIC_KEY) !== Boolean(v.VAPID_PRIVATE_KEY)) {
    ctx.addIssue({ code: 'custom', path: ['VAPID_PRIVATE_KEY'], message: 'set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY together, or neither' })
  }
  if (v.NODE_ENV === 'production') {
    // 🔴 a passkey is bound to its origin. An http or localhost origin in production verifies
    // nothing a browser will ever present, and the failure is a generic "assertion failed".
    if (v.WEBAUTHN_ORIGIN && !v.WEBAUTHN_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['WEBAUTHN_ORIGIN'], message: 'must be https:// in production' })
    }
    if (v.STORAGE_DRIVER === 's3') {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 's3 storage is not implemented yet — set STORAGE_DRIVER=local' })
    }
  }
})

let cached: z.infer<typeof schema> | null = null

/** The problems with an environment, one line each; empty when it is usable. Pure, so it is testable. */
export function envProblems(source: Record<string, string | undefined> = process.env): string[] {
  // an empty value (`FX_LIVE_RATES=` copied from .env.example) means "not set", not "set to nothing"
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''))
  const parsed = schema.safeParse(cleaned)
  return parsed.success ? [] : parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
}

/** Validated server env. Throws loudly at first use rather than failing at 3am. */
export function env() {
  if (cached) return cached
  const problems = envProblems()
  if (problems.length) throw new Error(`Invalid environment:\n${problems.join('\n')}`)
  cached = schema.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')))
  return cached
}
