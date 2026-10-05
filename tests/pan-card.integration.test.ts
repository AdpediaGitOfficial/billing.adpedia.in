import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { previewBill } from '@/server/services/purchases/bill'
import { savePans, panRegister } from '@/server/services/tax/pan-register'
import { confirmPanCard, unconfirmPanCard, panCards } from '@/server/services/tax/pan-card'
import { uploadAttachment } from '@/server/services/storage/attachment'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext
let freelancer = '', employeeId = ''

/** A one-pixel JPEG — enough to pass the magic-byte check without shipping a fixture. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

const putCard = (entityType: string, entityId: string, filename = 'pan.jpg') =>
  uploadAttachment(ctx, {
    kind: 'PAN_CARD', entityType, entityId, filename,
    contentType: 'image/jpeg', bytes: JPEG,
  })

const lines = [{ description: 'Edit', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18', expenseAccountCode: '5210' }]

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }

  freelancer = (await createVendor(ctx, {
    name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32',
    defaultTdsSection: '194J',
  })).id
  // 🔴 named — four employees are seeded, so an unordered findFirst is a coin toss (docs/80)
  employeeId = (await prisma.employee.findFirstOrThrow({
    where: { companyId: company.id, employeeCode: 'ADP-002' },
  })).id
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 a PAN furnished by the payee stops the 20%', () => {
  it('deducts at 20% while nothing is on file — s.206AA', async () => {
    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'MU/001', billDate: '2026-08-10', lines })
    expect(p.tds.ratePct.toFixed(0)).toBe('20')
    expect(p.tds.reason).toMatch(/206AA/)
  })

  it('drops to the section rate the moment the number is recorded', async () => {
    // 🔴 This is the bug docs/47 fixed. The register wrote panVerified: false on the grounds
    // that only a portal check could set it — and this system has no portal check, so a PAN
    // collected here left the payee at 20% for good.
    const r = await savePans(ctx, [{ kind: 'VENDOR', id: freelancer, pan: 'ABCPM1234K' }])
    expect(r.saved).toBe(1)

    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'MU/002', billDate: '2026-08-11', lines })
    expect(p.tds.ratePct.toFixed(0)).toBe('10')          // 194J
    expect(p.tds.reason).not.toMatch(/206AA/)
  })

  it('records how the number was come by', async () => {
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: freelancer } })
    expect(v.panEvidence).toBe('DECLARED')
    expect(v.panVerified).toBe(true)
  })

  it('asks for the card as a chase, not as a fault', async () => {
    // 🔴 The distinction is the point: nothing is wrong with this vendor, there is just
    // paperwork still to collect. Flagging it as an issue put an amber "check" against a row
    // whose rate was already right.
    const reg = await panRegister(ctx)
    const row = reg.rows.find((r) => r.id === freelancer)!
    expect(row.chases.join(' ')).toMatch(/No copy of the PAN card on file/)
    expect(row.issues).toHaveLength(0)
    expect(row.chases.join(' ')).not.toMatch(/portal/)
    expect(row.effectiveRatePct.toFixed(0)).toBe(row.correctRatePct.toFixed(0))
    expect(reg.undocumented).toBeGreaterThan(0)
  })
})

describe('the card itself', () => {
  it('refuses to confirm when no card is attached', async () => {
    await expect(confirmPanCard(ctx, 'VENDOR', freelancer))
      .rejects.toThrow(/No copy of .* PAN card is attached/)
  })

  it('stores an uploaded card against the vendor', async () => {
    const row = await putCard('Vendor', freelancer)
    expect(row.kind).toBe('PAN_CARD')

    const status = await panCards(ctx, 'VENDOR', freelancer)
    expect(status.cards).toHaveLength(1)
    expect(status.evidence).toBe('DECLARED')
  })

  it('says a card is attached but unconfirmed', async () => {
    const reg = await panRegister(ctx)
    const row = reg.rows.find((r) => r.id === freelancer)!
    expect(row.cards).toBe(1)
    expect(row.chases.join(' ')).toMatch(/nobody has confirmed it matches/)
  })

  it('records who confirmed it and when', async () => {
    await confirmPanCard(ctx, 'VENDOR', freelancer)
    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: freelancer } })
    expect(v.panEvidence).toBe('CARD_ON_FILE')
    expect(v.panEvidenceById).toBe(ctx.userId)
    expect(v.panEvidenceAt).not.toBeNull()

    const reg = await panRegister(ctx)
    const row = reg.rows.find((r) => r.id === freelancer)!
    expect(row.issues).toHaveLength(0)
    expect(row.chases).toHaveLength(0)
  })

  it('🔴 withdrawing the confirmation keeps the file and does not change the rate', async () => {
    // the payee did furnish the number, so s.206AA is still satisfied — this says only that
    // nobody now stands behind the comparison
    const r = await unconfirmPanCard(ctx, 'VENDOR', freelancer, 'Scan is illegible')
    expect(r.note).toMatch(/still on file/)

    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: freelancer } })
    expect(v.panEvidence).toBe('DECLARED')
    expect(v.panVerified).toBe(true)
    expect((await panCards(ctx, 'VENDOR', freelancer)).cards).toHaveLength(1)

    const p = await previewBill(ctx, { vendorId: freelancer, billNumber: 'MU/003', billDate: '2026-08-12', lines })
    expect(p.tds.ratePct.toFixed(0)).toBe('10')
  })

  it('refuses a card for a party in another company', async () => {
    await expect(putCard('Vendor', 'clzzzzzzzzzzzzzzzzzzzzzzz')).resolves.toBeTruthy()
    // the upload service itself is generic; the guard lives where the party is resolved
    await expect(confirmPanCard(ctx, 'VENDOR', 'clzzzzzzzzzzzzzzzzzzzzzzz'))
      .rejects.toThrow(/Vendor not found/)
  })

  it('refuses to confirm against a PAN that is not on file', async () => {
    const noPan = await createVendor(ctx, {
      name: 'Studio Hands', vendorType: 'OTHER', country: 'IN', stateCode: '32', defaultTdsSection: '194C',
    })
    await putCard('Vendor', noPan.id)
    await expect(confirmPanCard(ctx, 'VENDOR', noPan.id)).rejects.toThrow(/has no PAN recorded yet/)
  })
})

describe('employees', () => {
  it('takes a card and a confirmation the same way', async () => {
    await savePans(ctx, [{ kind: 'EMPLOYEE', id: employeeId, pan: 'ABCPK9876L' }])
    await putCard('Employee', employeeId)
    await confirmPanCard(ctx, 'EMPLOYEE', employeeId)

    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })
    expect(e.panEvidence).toBe('CARD_ON_FILE')
  })

  it('🔴 refuses a PAN that is not an individual’s, card or no card', async () => {
    // the 4th character is the entity type, and an employee's must be P
    await expect(savePans(ctx, [{ kind: 'EMPLOYEE', id: employeeId, pan: 'AAACK1234K' }]))
      .resolves.toMatchObject({ saved: 0 })
  })
})
