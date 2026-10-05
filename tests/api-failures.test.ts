import { describe, it, expect, vi, afterEach } from 'vitest'
import { fileError } from '@/app/api/_lib/handler'
import { AppError, NotFound } from '@/server/errors'

/**
 * docs/80 — nine file-serving routes turned every unexpected error into a tidy sentence and
 * wrote nothing down anywhere.
 */

afterEach(() => vi.restoreAllMocks())

describe('🔴 an unexpected failure is logged', () => {
  it('logs the cause, with the route that produced it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5461')

    const res = fileError(cause, 'tax/tds/export', 'Could not build the return')

    expect(res.status).toBe(500)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('tax/tds/export')
    expect(spy.mock.calls[0][1]).toBe(cause)
  })

  /**
   * 🔴 And the sentence the USER gets stays generic. A Prisma error carries table names, column
   * names and fragments of the query, and this response goes to a browser. The tidy message was
   * never the problem — losing the cause was.
   */
  it('tells the user nothing about the internals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = fileError(
      new Error('Invalid `prisma.financialYear.findFirstOrThrow()` invocation'),
      'tax/tds/export', 'Could not build the return',
    )
    const body = await res.text()
    expect(body).toBe('Could not build the return')
    expect(body).not.toMatch(/prisma|financialYear|invocation/i)
  })
})

describe('a refusal the code meant', () => {
  it('keeps its own message and status, and is not logged as a defect', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = fileError(new AppError('Unknown form'), 'tax/tds/export', 'Could not build the return')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Unknown form')

    const missing = fileError(new NotFound('Invoice not found'), 'invoices/[id]/document', 'Could not render the invoice')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('Invoice not found')

    expect(spy).not.toHaveBeenCalled()
  })

  it('is never cached, whichever way it went', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const e of [new AppError('nope'), new Error('boom')]) {
      expect(fileError(e, 'r', 'f').headers.get('cache-control')).toBe('no-store')
    }
  })
})
