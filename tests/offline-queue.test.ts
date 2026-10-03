import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { enqueue, listQueue, drain, pendingCount, newClientKey } from '@/lib/offline/queue'

const ok = () => new Response(JSON.stringify({ id: 'exp_1' }), { status: 200 })
const refuse = (status: number, error = 'nope') =>
  new Response(JSON.stringify({ error }), { status })

async function clear() {
  for (const i of await listQueue()) {
    const { remove } = await import('@/lib/offline/queue')
    await remove(i.clientKey)
  }
}

beforeEach(clear)

describe('the offline expense queue', () => {
  it('takes a submission while offline and reports it as pending', async () => {
    await enqueue({ taxableValue: '1200.00', description: 'Taxi to client' })
    expect(await pendingCount()).toBe(1)
  })

  it('generates a distinct key per expense', () => {
    const keys = new Set(Array.from({ length: 500 }, newClientKey))
    expect(keys.size).toBe(500)
  })

  it('sends queued items and clears them on success', async () => {
    await enqueue({ description: 'A' })
    await enqueue({ description: 'B' })
    const fetchImpl = vi.fn(async () => ok())

    const res = await drain(fetchImpl as unknown as typeof fetch)
    expect(res.sent).toBe(2)
    expect(res.remaining).toBe(0)
    expect(await listQueue()).toHaveLength(0)
  })

  it('🔴 replays the SAME clientKey after a failure, never a fresh one', async () => {
    // This is the whole safety property. If the first POST reached the server and only the
    // response was lost, the retry must be recognisable as the same expense — otherwise it
    // is booked twice and its input credit is claimed twice on the GST return.
    await enqueue({ description: 'Taxi', taxableValue: '450.00' })

    const seen: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)).clientKey)
      return seen.length === 1 ? Promise.reject(new Error('offline')) : ok()
    })

    await drain(fetchImpl as unknown as typeof fetch)   // fails, stays queued
    await drain(fetchImpl as unknown as typeof fetch)   // succeeds

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(await listQueue()).toHaveLength(0)
  })

  it('keeps an item queued when the network is down, and counts the attempt', async () => {
    await enqueue({ description: 'Parking' })
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })

    const res = await drain(fetchImpl as unknown as typeof fetch)
    expect(res.sent).toBe(0)
    expect(res.remaining).toBe(1)

    const [item] = await listQueue()
    expect(item.status).toBe('pending')
    expect(item.attempts).toBe(1)
    expect(item.lastError).toBe('No connection')
  })

  it('🔴 parks a rejected item instead of retrying it forever', async () => {
    // A 422 means the server read it and refused — a missing category, a closed period.
    // Retrying cannot fix that, and a queue that spins on it never drains.
    await enqueue({ description: 'Bad' })
    const fetchImpl = vi.fn(async () => refuse(422, 'Expense category not found'))

    await drain(fetchImpl as unknown as typeof fetch)
    const [item] = await listQueue()
    expect(item.status).toBe('failed')
    expect(item.lastError).toBe('Expense category not found')

    // and it is not silently dropped — it still shows up as needing attention
    expect(await pendingCount()).toBe(1)
  })

  it('does retry a 429 and a 408, which are temporary by definition', async () => {
    await enqueue({ description: 'Busy' })
    await drain((async () => refuse(429, 'slow down')) as unknown as typeof fetch)
    expect((await listQueue())[0].status).toBe('pending')

    await clear()
    await enqueue({ description: 'Timeout' })
    await drain((async () => refuse(408)) as unknown as typeof fetch)
    expect((await listQueue())[0].status).toBe('pending')
  })

  it('drains oldest first, so expenses land in the order they happened', async () => {
    await enqueue({ description: 'First' })
    await new Promise((r) => setTimeout(r, 2))
    await enqueue({ description: 'Second' })

    const order: string[] = []
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      order.push(JSON.parse(String(init.body)).description)
      return ok()
    })
    await drain(fetchImpl as unknown as typeof fetch)
    expect(order).toEqual(['First', 'Second'])
  })
})

describe('🔴 the receipt photo uploads separately from the expense', () => {
  it('posts the expense, then the photo', async () => {
    await enqueue({ description: 'Taxi' }, new Blob(['jpegbytes'], { type: 'image/jpeg' }))

    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url === '/api/expenses'
        ? new Response(JSON.stringify({ id: 'exp_7' }), { status: 200 })
        : new Response(JSON.stringify({ id: 'att_1' }), { status: 200 })
    })

    const res = await drain(fetchImpl as unknown as typeof fetch)
    expect(calls).toEqual(['/api/expenses', '/api/attachments'])
    expect(res.sent).toBe(1)
    expect(await listQueue()).toHaveLength(0)
  })

  it('🔴 never re-posts the expense when only the photo failed', async () => {
    // This is the whole point of recording expenseId. The expense is already booked; a
    // naive retry would book it again — and claim its input credit twice.
    await enqueue({ description: 'Parking' }, new Blob(['jpegbytes'], { type: 'image/jpeg' }))

    let expensePosts = 0
    const flaky = vi.fn(async (url: string) => {
      if (url === '/api/expenses') { expensePosts += 1; return new Response(JSON.stringify({ id: 'exp_9' }), { status: 200 }) }
      throw new Error('upload failed')
    })
    await drain(flaky as unknown as typeof fetch)
    expect(expensePosts).toBe(1)
    expect((await listQueue())[0].expenseId).toBe('exp_9')

    // second attempt: the photo goes up, the expense is not touched again
    const calls: string[] = []
    const good = vi.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/expenses') expensePosts += 1
      return new Response(JSON.stringify({ id: 'att_2' }), { status: 200 })
    })
    await drain(good as unknown as typeof fetch)

    expect(calls).toEqual(['/api/attachments'])
    expect(expensePosts).toBe(1)
    expect(await listQueue()).toHaveLength(0)
  })

  it('🔴 keeps a photo the server refuses, and says why', async () => {
    // It used to return "stop asking": the item was removed and the photo went with it, so
    // the expense stayed booked with nothing behind it and nobody was told. After docs/59
    // that is an input-credit claim with no evidence — exactly what that screen surfaces.
    await enqueue({ description: 'Toll' }, new Blob(['nope'], { type: 'image/svg+xml' }))
    const fetchImpl = vi.fn(async (url: string) =>
      url === '/api/expenses'
        ? new Response(JSON.stringify({ id: 'exp_11' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'image/svg+xml cannot be stored' }), { status: 422 }))

    const res = await drain(fetchImpl as unknown as typeof fetch)
    // the EXPENSE went; the photo did not
    expect(res.sent).toBe(0)
    expect(res.failed).toBe(1)

    const [item] = await listQueue()
    expect(item.expenseId).toBe('exp_11')
    expect(item.status).toBe('failed')
    expect(item.lastError).toMatch(/image\/svg\+xml cannot be stored/)
  })

  it('🔴 never re-posts the expense for a refused photo, however often it is drained', async () => {
    let expensePosts = 0
    const again = vi.fn(async (url: string) => {
      if (url === '/api/expenses') { expensePosts += 1; return new Response(JSON.stringify({ id: 'x' }), { status: 200 }) }
      return new Response(JSON.stringify({ error: 'still no' }), { status: 422 })
    })
    await drain(again as unknown as typeof fetch)
    await drain(again as unknown as typeof fetch)
    expect(expensePosts).toBe(0)
  })

  it('an expense with no photo is unaffected', async () => {
    await enqueue({ description: 'Bank charge' })
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ id: 'exp_12' }), { status: 200 })
    })
    await drain(fetchImpl as unknown as typeof fetch)
    expect(calls).toEqual(['/api/expenses'])
  })
})
