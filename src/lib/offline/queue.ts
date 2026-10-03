/**
 * The offline expense queue.
 *
 * An expense gets filed where it happens — a taxi rank, a hotel lobby, a client's
 * basement car park — which is exactly where there is no signal. The queue takes the
 * submission immediately, stores it locally, and drains it when the network returns.
 *
 * IndexedDB, not localStorage: a receipt photo is a Blob, and localStorage holds strings
 * and caps out around 5MB.
 */

export interface QueuedExpense {
  /** 🔴 generated HERE, before the first attempt, and reused on every retry */
  clientKey: string
  payload: Record<string, unknown>
  receipt?: Blob
  createdAt: number
  attempts: number
  lastError?: string
  /** 🔴 set once the expense itself is accepted, so a retry never re-posts it */
  expenseId?: string
  status: 'pending' | 'syncing' | 'done' | 'failed'
}

const DB_NAME = 'adpedia-offline'
const STORE = 'expense-queue'
const VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientKey' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/**
 * A key that is unique without a server round trip, since by definition we cannot reach
 * the server when this is created. `crypto.randomUUID` where available; otherwise random
 * bytes, never a timestamp alone — two expenses filed in the same millisecond on the same
 * phone would collide, and a collision here means one is silently dropped as a duplicate.
 */
export function newClientKey(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  c?.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function enqueue(payload: Record<string, unknown>, receipt?: Blob): Promise<QueuedExpense> {
  const item: QueuedExpense = {
    clientKey: newClientKey(),
    payload, receipt,
    createdAt: Date.now(), attempts: 0, status: 'pending',
  }
  await tx('readwrite', (s) => s.put(item))
  return item
}

export async function listQueue(): Promise<QueuedExpense[]> {
  const all = await tx<QueuedExpense[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedExpense[]>)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function pendingCount(): Promise<number> {
  const all = await listQueue()
  return all.filter((i) => i.status === 'pending' || i.status === 'failed').length
}

/**
 * The ones that will never go on their own — docs/60.
 *
 * 🔴 Reported separately from `pending`, because the two need different words. "3 waiting
 * to sync" is reassuring and right for a queue that is merely offline; it is a lie about an
 * item the server has already refused, which will still be there tomorrow and the day after.
 */
export async function stuckItems(): Promise<{ description: string; error: string }[]> {
  const all = await listQueue()
  return all.filter((i) => i.status === 'failed').map((i) => ({
    description: String(i.payload?.description ?? 'An expense'),
    error: i.lastError ?? 'It was refused and no reason was given',
  }))
}

async function update(item: QueuedExpense) {
  await tx('readwrite', (s) => s.put(item))
}

export async function remove(clientKey: string) {
  await tx('readwrite', (s) => s.delete(clientKey))
}

export interface SyncResult { sent: number; failed: number; remaining: number }

/**
 * Drain the queue.
 *
 * 🔴 A failed POST is NOT removed and NOT given a new key. The same `clientKey` goes back
 * on the wire every time, so if a previous attempt actually reached the server before the
 * connection dropped, the retry is recognised and discarded there rather than booking the
 * expense — and its input credit — a second time.
 */
export async function drain(fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const items = (await listQueue()).filter((i) => i.status !== 'done')
  let sent = 0, failed = 0

  for (const item of items) {
    item.status = 'syncing'
    item.attempts += 1
    await update(item)

    try {
      // the expense is already booked from an earlier attempt — only the photo is left
      if (item.expenseId) {
        if (!item.receipt) { await remove(item.clientKey); sent += 1; continue }
        const r = await uploadReceipt(fetchImpl, item.expenseId, item.receipt)
        if (r.ok) { await remove(item.clientKey); sent += 1; continue }
        item.status = r.permanent ? 'failed' : 'pending'
        item.lastError = r.error ?? 'Expense saved; the receipt photo is still to upload'
        await update(item)
        failed += 1
        continue
      }

      const res = await fetchImpl('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item.payload, clientKey: item.clientKey }),
      })

      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { id?: string }
        if (body.id) item.expenseId = body.id

        // 🔴 The receipt is uploaded SEPARATELY, after the expense exists — it needs the
        // expense's id to attach to. If this fails the expense stays booked and only the
        // photo is retried: `expenseId` is recorded first, so the next drain skips straight
        // past the POST and never books a second expense for the sake of a failed image.
        if (item.receipt && item.expenseId) {
          const uploaded = await uploadReceipt(fetchImpl, item.expenseId, item.receipt)
          if (!uploaded.ok) {
            // 🔴 docs/60 — a photo the server REFUSES is kept and reported, not dropped.
            // It used to return "stop asking", the item was removed, and the photo went
            // with it: the expense stayed booked with no bill behind it and nobody was
            // told why. After docs/59 that silently becomes an input-credit claim with no
            // evidence — the exact thing that screen exists to surface.
            item.status = uploaded.permanent ? 'failed' : 'pending'
            item.lastError = uploaded.error ?? 'Expense saved; the receipt photo is still to upload'
            await update(item)
            failed += 1
            continue
          }
        }

        await remove(item.clientKey)
        sent += 1
        continue
      }

      // 4xx other than 408/429 means the server understood and refused: retrying cannot
      // help, and leaving it 'pending' would spin forever. Park it for the person to fix.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
      const body = await res.json().catch(() => ({}))
      item.status = permanent ? 'failed' : 'pending'
      item.lastError = body?.error ?? `HTTP ${res.status}`
      await update(item)
      failed += 1
    } catch {
      // offline again mid-drain — stay pending, keep the key, try later
      item.status = 'pending'
      item.lastError = 'No connection'
      await update(item)
      failed += 1
    }
  }

  return { sent, failed, remaining: await pendingCount() }
}

export interface UploadOutcome {
  ok: boolean
  /** retrying cannot help — the file itself was refused */
  permanent: boolean
  error?: string
}

/**
 * Put the photo up against an expense that already exists.
 *
 * 🔴 A 4xx means the file itself is unacceptable and retrying cannot fix it. That is NOT
 * the same as success: the expense is booked and now has nothing behind it, so the item is
 * kept as `failed` carrying the server's own words. The queue screen can then say *"that
 * file says it is image/png but its contents are not"* instead of the photo simply
 * vanishing from the phone.
 */
async function uploadReceipt(fetchImpl: typeof fetch, expenseId: string, receipt: Blob): Promise<UploadOutcome> {
  const form = new FormData()
  form.append('file', receipt, 'receipt')
  form.append('kind', 'RECEIPT')
  form.append('entityType', 'Expense')
  form.append('entityId', expenseId)
  try {
    const res = await fetchImpl('/api/attachments', { method: 'POST', body: form })
    if (res.ok) return { ok: true, permanent: false }
    const body = await res.json().catch(() => ({})) as { error?: string }
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
    return { ok: false, permanent, error: body.error ?? `The receipt was refused (HTTP ${res.status})` }
  } catch {
    return { ok: false, permanent: false }
  }
}
