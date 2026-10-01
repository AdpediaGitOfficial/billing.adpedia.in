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
        if (!item.receipt || await uploadReceipt(fetchImpl, item.expenseId, item.receipt)) {
          await remove(item.clientKey)
          sent += 1
        } else {
          item.status = 'pending'
          item.lastError = 'Expense saved; the receipt photo is still to upload'
          await update(item)
          failed += 1
        }
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
          if (!uploaded) {
            item.status = 'pending'
            item.lastError = 'Expense saved; the receipt photo is still to upload'
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

/** Returns true when the photo is stored, false to leave it queued for another go. */
async function uploadReceipt(fetchImpl: typeof fetch, expenseId: string, receipt: Blob): Promise<boolean> {
  const form = new FormData()
  form.append('file', receipt, 'receipt')
  form.append('kind', 'RECEIPT')
  form.append('entityType', 'Expense')
  form.append('entityId', expenseId)
  try {
    const res = await fetchImpl('/api/attachments', { method: 'POST', body: form })
    // a 4xx here means the file itself is unacceptable — retrying cannot fix that, and the
    // expense is already safely booked, so stop asking
    if (!res.ok && res.status >= 400 && res.status < 500) return true
    return res.ok
  } catch {
    return false
  }
}
