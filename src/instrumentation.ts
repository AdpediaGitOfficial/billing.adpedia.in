/**
 * Runs once when the server starts — docs/95.
 *
 * 🔴 `env()` already throws on a bad value, but only when something first asks for it, which in
 * a quiet hour is a customer's first login. Reading it here turns a misconfigured box into a
 * process that refuses to start, with the reason in the pm2 log, instead of one that starts and
 * fails feature by feature. Node runtime only: the edge middleware must not import this.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { env } = await import('@/lib/env')
  env()
}
