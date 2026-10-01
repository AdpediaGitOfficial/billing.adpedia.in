import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Where uploaded files live.
 *
 * One interface, two drivers: the local filesystem (which works today, with nothing to
 * provision) and S3-compatible object storage behind configuration. Everything above this
 * line stores an opaque key and never knows the difference.
 */
export interface StorageDriver {
  readonly name: string
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  remove(key: string): Promise<void>
}

/**
 * 🔴 The storage key is GENERATED, never derived from the uploaded filename.
 *
 * A filename is attacker-controlled. `../../../etc/passwd`, a leading `/`, a NUL byte, a
 * Windows device name, a 4000-character path — every one of those is a real upload, and
 * sanitising them correctly is a losing game. Generating the key sidesteps the entire class:
 * the original name is kept only as a label to show on download.
 *
 * The date prefix is for humans browsing the bucket, not for lookup.
 */
export function newStorageKey(companyId: string, contentType: string): string {
  const now = new Date()
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const ext = EXT_BY_TYPE[contentType] ?? 'bin'
  return `${companyId}/${yyyymm}/${randomBytes(16).toString('hex')}.${ext}`
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'application/pdf': 'pdf', 'text/csv': 'csv', 'text/plain': 'txt',
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/* ── local filesystem ────────────────────────────────────────────────────────── */

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local'
  private readonly root: string

  constructor(root = process.env.STORAGE_DIR ?? join(process.cwd(), '.storage')) {
    this.root = resolve(root)
  }

  /**
   * 🔴 Belt and braces: even though keys are generated, every path is re-checked to be
   * inside the root before it is touched. If a key ever did come from somewhere else, this
   * is what stops it writing outside the storage directory.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key))
    if (full !== this.root && !full.startsWith(this.root + '/')) {
      throw new Error('Refusing a storage key that escapes the storage directory')
    }
    return full
  }

  async put(key: string, bytes: Buffer) {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key))
  }

  async remove(key: string) {
    await unlink(this.pathFor(key)).catch(() => {})
  }
}

/* ── S3-compatible ───────────────────────────────────────────────────────────── */

/**
 * Not implemented, and says so.
 *
 * 🔴 Adpedia has no object storage provisioned and no credentials. An untested S3 client
 * that merely looks finished is worse than an honest gap — it would be discovered the first
 * time a receipt failed to upload, which is exactly when nobody is watching. The local
 * driver works today and the interface means swapping is a constructor, not surgery.
 *
 * To complete it: `@aws-sdk/client-s3`, `PutObjectCommand` / `GetObjectCommand`, and
 * STORAGE_S3_* configuration. Bucket must NOT be public — downloads go through this app so
 * the company check in `attachment.ts` still applies.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3 (not implemented)'
  async put(): Promise<void> {
    throw new Error('S3 storage is not implemented — see docs/38 §6. Unset STORAGE_DRIVER to use local storage.')
  }
  async get(): Promise<Buffer> {
    throw new Error('S3 storage is not implemented — see docs/38 §6.')
  }
  async remove(): Promise<void> {
    throw new Error('S3 storage is not implemented — see docs/38 §6.')
  }
}

let cached: StorageDriver | null = null

export function storage(): StorageDriver {
  if (!cached) {
    cached = process.env.STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver()
  }
  return cached
}

/** Tests swap the driver rather than touching the filesystem. */
export function setStorageDriver(d: StorageDriver | null) { cached = d }
