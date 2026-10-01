import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import {
  uploadAttachment, readAttachment, listAttachments, detachAttachment, safeDownloadHeaders, MAX_BYTES,
} from '@/server/services/storage/attachment'
import { setStorageDriver, newStorageKey, LocalStorageDriver } from '@/server/services/storage/driver'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext

/** In-memory driver — these tests are about the rules, not the filesystem. */
const files = new Map<string, Buffer>()
const memory = {
  name: 'memory',
  async put(key: string, bytes: Buffer) { files.set(key, bytes) },
  async get(key: string) {
    const b = files.get(key)
    if (!b) throw new Error('missing')
    return b
  },
  async remove(key: string) { files.delete(key) },
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(64, 3)])

beforeAll(async () => {
  await resetDb(prisma)
  setStorageDriver(memory)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
})
afterAll(async () => { setStorageDriver(null); await prisma.$disconnect() })

const upload = (over: Partial<Parameters<typeof uploadAttachment>[1]> = {}) =>
  uploadAttachment(ctx, {
    kind: 'RECEIPT', entityType: 'Expense', entityId: 'exp-1',
    filename: 'receipt.png', contentType: 'image/png', bytes: PNG, ...over,
  })

describe('storing a file', () => {
  it('stores it and reads it back byte for byte', async () => {
    const row = await upload()
    const { bytes } = await readAttachment(ctx, row.id)
    expect(bytes.equals(PNG)).toBe(true)
    expect(row.sizeBytes).toBe(PNG.length)
  })

  it('deduplicates the same file on the same record', async () => {
    const a = await upload({ entityId: 'exp-dedupe' })
    const b = await upload({ entityId: 'exp-dedupe' })
    expect(b.id).toBe(a.id)
  })

  it('accepts a JPEG and a PDF', async () => {
    await expect(upload({ contentType: 'image/jpeg', bytes: JPEG, filename: 'r.jpg', entityId: 'e2' })).resolves.toBeTruthy()
    await expect(upload({ contentType: 'application/pdf', bytes: PDF, filename: 'b.pdf', kind: 'VENDOR_INVOICE', entityId: 'e3' })).resolves.toBeTruthy()
  })

  it('refuses an empty file and one over the limit', async () => {
    await expect(upload({ bytes: Buffer.alloc(0) })).rejects.toThrow(/empty/)
    await expect(upload({ bytes: Buffer.alloc(MAX_BYTES + 1, 1) })).rejects.toThrow(/limit/)
  })
})

describe('🔴 what may be stored', () => {
  it('refuses SVG, which is an image that can carry script', async () => {
    await expect(upload({
      contentType: 'image/svg+xml', filename: 'logo.svg',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    })).rejects.toThrow(/cannot be stored/)
  })

  it('refuses HTML outright', async () => {
    await expect(upload({
      contentType: 'text/html', filename: 'x.html', bytes: Buffer.from('<h1>hi</h1>'),
    })).rejects.toThrow(/cannot be stored/)
  })

  it('🔴 refuses a file whose CONTENTS do not match what it claims to be', async () => {
    // the client controls Content-Type completely. HTML labelled image/png, stored as an
    // image and ever served inline, would execute with the signed-in user's session.
    await expect(upload({
      contentType: 'image/png', filename: 'evil.png',
      bytes: Buffer.from('<html><script>alert(document.cookie)</script></html>'),
    })).rejects.toThrow(/says it is image\/png but its contents are not/)
  })

  it('also catches a PDF that is not a PDF', async () => {
    await expect(upload({
      contentType: 'application/pdf', filename: 'x.pdf', bytes: Buffer.from('not a pdf at all'),
    })).rejects.toThrow(/contents are not/)
  })
})

describe('🔴 the filename never reaches the storage path', () => {
  it('keeps a traversal attempt as a harmless label', async () => {
    const row = await upload({ filename: '../../../etc/passwd', entityId: 'trav' })
    expect(row.filename).not.toContain('..')
    expect(row.filename).not.toContain('/')
    // and the key is generated, so the label could not have influenced it either way
    expect(row.storageKey).not.toContain('passwd')
    expect(row.storageKey).toMatch(/^[a-z0-9]+\/\d{6}\/[0-9a-f]{32}\.png$/)
  })

  it('strips the RTL override used to disguise an executable', async () => {
    // "receipt<U+202E>gpj.exe" displays as "receipt.exe" reversed — it reads as an image
    const row = await upload({ filename: 'receipt‮gpj.exe', entityId: 'rtl' })
    expect(row.filename).not.toContain('‮')
  })

  it('always ends in an extension matching what was actually stored', async () => {
    const row = await upload({ filename: 'scan', entityId: 'ext' })
    expect(row.filename.endsWith('.png')).toBe(true)
  })
})

describe('🔴 serving a stored file', () => {
  it('forces a download and forbids sniffing or execution', () => {
    const h = safeDownloadHeaders('image/png', 'receipt.png') as Record<string, string>
    expect(h['content-disposition']).toMatch(/^attachment;/)
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['content-security-policy']).toContain("default-src 'none'")
    expect(h['cache-control']).toContain('no-store')
  })

  it('a quote in the filename cannot break out of the header', () => {
    const h = safeDownloadHeaders('image/png', 'a"; x=y.png') as Record<string, string>
    expect(h['content-disposition']).toBe('attachment; filename="a; x=y.png"')
  })
})

describe('🔴 company scoping', () => {
  it('refuses to read another company’s attachment', async () => {
    const row = await upload({ entityId: 'scoped' })
    const other = { ...ctx, companyId: 'some-other-company' }
    await expect(readAttachment(other, row.id)).rejects.toThrow(/not found/i)
  })
})

describe('detaching keeps the evidence', () => {
  it('hides it from the list but does not destroy the file', async () => {
    const row = await upload({ entityId: 'detachable' })
    expect(await listAttachments(ctx, 'Expense', 'detachable')).toHaveLength(1)

    await detachAttachment(ctx, row.id, 'Attached to the wrong expense')
    expect(await listAttachments(ctx, 'Expense', 'detachable')).toHaveLength(0)

    // 🔴 still readable, and still stored — it is the proof behind an ITC claim
    const { bytes } = await readAttachment(ctx, row.id)
    expect(bytes.equals(PNG)).toBe(true)
  })
})

describe('the local driver', () => {
  it('🔴 refuses a key that would escape the storage directory', async () => {
    const local = new LocalStorageDriver('/tmp/adpedia-storage-test')
    await expect(local.get('../../../etc/passwd')).rejects.toThrow(/escapes the storage directory/)
    await expect(local.put('../../escape.txt', Buffer.from('x')))
      .rejects.toThrow(/escapes the storage directory/)
  })

  it('generates keys that collide only astronomically', () => {
    const keys = new Set(Array.from({ length: 2000 }, () => newStorageKey('co', 'image/png')))
    expect(keys.size).toBe(2000)
  })
})
