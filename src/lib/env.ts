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
})

let cached: z.infer<typeof schema> | null = null

/** Validated server env. Throws loudly at first use rather than failing at 3am. */
export function env() {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${issues}`)
  }
  cached = parsed.data
  return cached
}
