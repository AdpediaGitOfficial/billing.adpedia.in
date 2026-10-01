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
