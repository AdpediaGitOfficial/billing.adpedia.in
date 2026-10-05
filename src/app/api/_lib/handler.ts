import { NextResponse } from 'next/server'
import { AppError } from '@/server/errors'
import { ZodError } from 'zod'

/** Wraps a route handler so domain errors become clean JSON instead of stack traces. */
export function handler<T>(fn: () => Promise<T>) {
  return fn()
    .then((data) => NextResponse.json(data ?? { ok: true }))
    .catch((e: unknown) => {
      if (e instanceof ZodError) {
        return NextResponse.json(
          { error: 'Invalid input', code: 'VALIDATION', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          { status: 422 },
        )
      }
      if (e instanceof AppError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
      }
      console.error('unhandled route error', e)
      return NextResponse.json({ error: 'Something went wrong', code: 'INTERNAL' }, { status: 500 })
    })
}

/**
 * The same discipline for routes that return a FILE rather than JSON — docs/80.
 *
 * 🔴 Nine of them hand-rolled this and all nine dropped the logging:
 *
 * ```ts
 * return new Response(e instanceof AppError ? e.message : 'Could not render the invoice', { status })
 * ```
 *
 * A tidy sentence for the user and **nothing written down anywhere**. In production that makes
 * every unexpected failure in a PDF or an export undiagnosable: you learn that something broke
 * and not one thing more. The careful version already existed, ten lines above, and the file
 * routes had quietly diverged from it.
 *
 * 🔴 The message the user sees stays generic on purpose. A Prisma error carries table names,
 * column names and fragments of the query, and this response goes to a browser. What changes
 * is that the cause is logged, with the route that produced it — the tidy message was never
 * the problem.
 */
export function fileError(e: unknown, route: string, fallback: string): Response {
  if (e instanceof AppError) {
    return new Response(e.message, { status: e.status, headers: { 'cache-control': 'no-store' } })
  }
  console.error(`unhandled route error · ${route}`, e)
  return new Response(fallback, { status: 500, headers: { 'cache-control': 'no-store' } })
}
