import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { outstandingChases, recordChase, chaseHistory, chaseTotals } from '@/server/services/compliance/chases'
import { closePdfBrowser } from '@/server/services/invoicing/pdf'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', noPanVendorId = '', withPanVendorId = '', invoiceId = ''

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  noPanVendorId = (await createVendor(ctx, {
    name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32',
    defaultTdsSection: '194J', email: 'maneesh@example.com',
  })).id
  withPanVendorId = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C', email: 'accounts@exalture.example',
  })).id

  for (const [vendorId, n] of [[noPanVendorId, 'MU/300'], [withPanVendorId, 'EX/300']] as const) {
    await approveBill(ctx, (await createBill(ctx, {
      vendorId, billNumber: n, billDate: '2026-06-10',
      lines: [{ description: 'Work', sacCode: '998314', quantity: '1', rate: '200000', gstRatePct: '18', expenseAccountCode: '5220' }],
    })).id)
  }

  const customer = await prisma.customer.create({
    data: { companyId, name: 'Click AR Business Private Limited', country: 'IN', stateCode: '32',
      gstin: '32AAKCC9890P1ZS', customerType: 'B2B', paymentTermDays: 15, billingAddress: {},
      email: 'accounts@clickar.example' },
  })
  invoiceId = (await sendInvoice(ctx, (await createInvoice(ctx, {
    customerId: customer.id, date: '2026-05-01',
    lines: [{ description: 'Staff augmentation', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }],
  })).id)).id
})
afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect() })

describe('🔴 what this company is waiting on somebody else for', () => {
  it('asks the vendor with no PAN, and says what it is costing them', async () => {
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'PAN_NUMBER' && c.subjectId === noPanVendorId)
    expect(row).toBeTruthy()
    expect(row!.email).toBe('maneesh@example.com')
    // the sentence that actually gets a reply
    expect(row!.body).toMatch(/section 206AA requires us to deduct at 20%/)
    expect(row!.body).toMatch(/you would only get it back by claiming a refund/)
    expect(row!.lastAskedAt).toBeNull()
  })

  it('asks for a copy of the card where the number is already on file', async () => {
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'PAN_CARD' && c.subjectId === withPanVendorId)
    expect(row).toBeTruthy()
    expect(row!.body).toContain('AABCE1234F')
    expect(row!.why).toMatch(/no copy of the card/i)
  })

  it('chases an overdue invoice with its number and what is left on it', async () => {
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'INVOICE_OVERDUE' && c.subjectId === invoiceId)
    expect(row).toBeTruthy()
    expect(row!.subject).toMatch(/ADP\//)
    // 🔴 written the way a person writes a date, not as a log line
    expect(row!.body).toMatch(/fell due on \d{2} \w{3} 2026/)
    expect(row!.body).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(row!.amount!.toFixed(2)).toBe('118000.00')
  })

  it('🔴 never puts the review marker in a message that leaves the building', async () => {
    const chases = await outstandingChases(ctx)
    for (const c of chases) {
      expect(c.subject).not.toContain('\u{1F534}')
      expect(c.body).not.toContain('\u{1F534}')
    }
  })

  it('🔴 tells an EMPLOYEE what they actually lose, not a vendor rate', async () => {
    // the first draft told salaried people that s.206AA deducts 20% "instead of 0%
    // (section 192)" — false twice over. Salary TDS is not a rate, and 206AA on salary is
    // a floor, which is what docs/47 §1 says and this contradicted.
    const chases = await outstandingChases(ctx)
    const employee = chases.find((c) => c.kind === 'PAN_NUMBER' && /Form 16/.test(c.subject))
    if (employee) {
      expect(employee.body).toMatch(/cannot be credited to you/)
      expect(employee.body).toMatch(/Form 16/)
      expect(employee.body).not.toMatch(/instead of 0%/)
    }
    for (const c of chases) expect(c.body).not.toMatch(/instead of 0%/)
  })

  it('🔴 does not shout the company name in a signature', async () => {
    const chases = await outstandingChases(ctx)
    for (const c of chases) {
      expect(c.body).not.toMatch(/Thank you,\nADPEDIA FILMS PRIVATE LIMITED/)
      expect(c.body).toMatch(/Thank you,\nAdpedia Films Private Limited/)
    }
  })

  it('signs every message, so it does not read like phishing', async () => {
    const chases = await outstandingChases(ctx)
    expect(chases.length).toBeGreaterThan(0)
    for (const c of chases) {
      expect(c.body).toMatch(/Thank you,\nAdpedia/)
    }
  })

  it('totals what is sitting behind somebody else', async () => {
    const t = chaseTotals(await outstandingChases(ctx))
    expect(t.count).toBeGreaterThan(2)
    expect(t.neverAsked).toBe(t.count)
    expect(t.owedToUs.toFixed(2)).toBe('118000.00')
    expect(t.overWithheld.gte(0)).toBe(true)
  })
})

describe('🔴 recording that it was actually sent', () => {
  it('keeps the words, not just the fact', async () => {
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'PAN_NUMBER')!
    await recordChase(ctx, {
      kind: 'PAN_NUMBER', subjectId: row.subjectId, partyName: row.partyName,
      sentTo: 'maneesh@example.com', channel: 'EMAIL',
      message: `${row.subject}\n\n${row.body}`,
    })
    const [logged] = await chaseHistory(ctx)
    expect(logged.partyName).toBe(row.partyName)
    expect(logged.message).toContain('206AA')
    expect(logged.sentTo).toBe('maneesh@example.com')
  })

  it('shows on the next read when it was last asked', async () => {
    const chases = await outstandingChases(ctx)
    const row = chases.find((c) => c.kind === 'PAN_NUMBER')!
    expect(row.lastAskedAt).not.toBeNull()
  })

  it('refuses a record that does not say where it went', async () => {
    await expect(recordChase(ctx, {
      kind: 'PAN_CARD', subjectId: withPanVendorId, partyName: 'Exalture',
      sentTo: ' ', channel: 'EMAIL', message: 'hello',
    })).rejects.toThrow(/Say where it was sent/)
  })

  it('🔴 does not drop the chase once it has been asked — it is still outstanding', async () => {
    // asking is not getting. The row stays until the PAN actually arrives, marked with
    // when it was last asked, because a chase that disappears on sending is a chase
    // nobody follows up.
    const chases = await outstandingChases(ctx)
    expect(chases.some((c) => c.kind === 'PAN_NUMBER' && c.subjectId === noPanVendorId)).toBe(true)
  })
})
