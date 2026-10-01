import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),        // 15 min
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),   // 30 days
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
