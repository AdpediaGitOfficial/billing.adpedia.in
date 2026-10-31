import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resetDb } from './helpers/db'
import { createCompany } from '@/server/services/company/create'
import { createInvoice, sendInvoice } from '@/server/services/invoicing/invoice'
import { buildGstr1 } from '@/server/services/tax/gstr1'
import { buildGstr3b } from '@/server/services/tax/gstr3b'
import { recordGstFiling } from '@/server/services/tax/gst-filing'
import { recordGstPayment } from '@/server/services/tax/gst-payment'
import { recordSetOff } from '@/server/services/tax/gst-setoff'
import { import2b } from '@/server/services/tax/gstr2b'
import { importPortalStatement } from '@/server/services/tax/portal-reconciliation'
import { addLut } from '@/server/services/invoicing/lut'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import { NAV } from '@/components/shell/nav'
import type { RequestContext } from '@/server/context'

/**
 * docs/82 §4 — the GST surface, refused rather than merely hidden.
 *
 * 🔴 Step 3 hid the GST items from an unregistered entity's rail and put an explanation on the
 * three screens. Neither is a refusal. Every path below WORKED for entity B before this: a
 * GSTR-1 built out of its bills of supply, a filing recorded against a return it must not
 * file, a challan posted for tax it never collected. Nothing crashed and nothing looked wrong
 * — which is the whole problem, because what comes out is a plausible return for a taxpayer
 * that does not exist.
 *
 * The composition entity is here because the old condition was `if (company.gstin)`, and a
 * GSTIN is not the question: a composition taxpayer has one and files CMP-08 and GSTR-4.
 */

const prisma = new PrismaClient()
let ctxA: RequestContext, ctxB: RequestContext, ctxC: RequestContext
const PERIOD = { from: new Date('2026-04-01'), to: new Date('2027-03-31T23:59:59Z') }

const BASE = {
  constitution: 'PROPRIETORSHIP' as const, stateCode: '32',
  address: { line1: 'VIII/318, Chinnangath House', city: 'Thrissur', state: 'Kerala', pincode: '680683' },
}

beforeAll(async () => {
  await resetDb(prisma)
  const a = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctxA = { userId: user.id, companyId: a.id, role: 'OWNER' }

  const b = await createCompany(ctxA, {
    ...BASE, legalName: 'UNREGISTERED PROPRIETOR', pan: 'AAAPA1234A', seriesPrefix: 'UNR',
  })
  const c = await createCompany(ctxA, {
    ...BASE, legalName: 'COMPOSITION PROPRIETOR', pan: 'AAFPB5678C', seriesPrefix: 'CMP',
    gstin: '32AAFPB5678C1Z5', gstRegistrationType: 'COMPOSITION',
  })
  ctxB = { userId: user.id, companyId: b.id, role: 'OWNER' }
  ctxC = { userId: user.id, companyId: c.id, role: 'OWNER' }

  // 🔴 C needs a supply of its own, or the calendar has no period to push and the composition
  // assertions below pass because there is nothing there rather than because it is gated.
  const custC = await prisma.customer.create({ data: {
    companyId: c.id, name: 'Client of the composition dealer', country: 'IN', stateCode: '32',
    customerType: 'B2C', paymentTermDays: 15, billingAddress: {},
  } })
  const draftC = await createInvoice(ctxC, { customerId: custC.id, date: '2026-10-01',
    lines: [{ description: 'Shoot day', sacCode: '998314', quantity: '1', rate: '30000', gstRatePct: '0' }] })
  await sendInvoice(ctxC, draftC.id)

  // 🔴 the positive control: A is REGULAR, and everything refused below must still work for it.
  // Without an invoice of its own the calendar has no GST period to push, and the assertions
  // at the bottom would pass for the wrong reason.
  const custA = await prisma.customer.create({ data: {
    companyId: a.id, name: 'Registered client of A', country: 'IN', stateCode: '32',
    customerType: 'B2B', gstin: '32AABCU9603R1ZM', paymentTermDays: 15, billingAddress: {},
  } })
  const draftA = await createInvoice(ctxA, { customerId: custA.id, date: '2026-10-01',
    lines: [{ description: 'Film production', sacCode: '998314', quantity: '1', rate: '100000', gstRatePct: '18' }] })
  await sendInvoice(ctxA, draftA.id)
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 what an unregistered entity is refused', () => {
  it('a GSTR-1 built from its bills of supply', async () => {
    await expect(buildGstr1(ctxB.companyId, PERIOD.from, PERIOD.to, '2026-27'))
      .rejects.toThrow(/not registered for GST/i)
  })

  it('a GSTR-3B', async () => {
    await expect(buildGstr3b(ctxB.companyId, PERIOD.from, PERIOD.to, '2026-27'))
      .rejects.toThrow(/not registered for GST/i)
  })

  it('recording a filing it never made', async () => {
    await expect(recordGstFiling(ctxB, { returnType: 'GSTR1', periodLabel: '2026-Q2', filedOn: '2026-10-11' }))
      .rejects.toThrow(/not registered for GST/i)
  })

  it('a challan for tax it never collected', async () => {
    await expect(recordGstPayment(ctxB, { periodLabel: '2026-Q2', paidOn: '2026-10-20', igst: '5000' }))
      .rejects.toThrow(/not registered for GST/i)
  })

  it('a set-off through electronic ledgers it does not have', async () => {
    await expect(recordSetOff(ctxB, { periodLabel: '2026-Q2', setOffOn: '2026-10-20' }))
      .rejects.toThrow(/not registered for GST/i)
  })

  it('a GSTR-2B, which the department does not produce for it', async () => {
    await expect(import2b(ctxB, { asOn: '2026-10-14', text: '{}' }))
      .rejects.toThrow(/not registered for GST/i)
  })

  /**
   * 🔴 The one docs/82 §5 singles out. A LUT invites zero-rating an export, and an
   * unregistered person's export is not zero-rated — it is outside GST altogether.
   */
  it('🔴 a Letter of Undertaking', async () => {
    await expect(addLut(ctxB, { arn: 'AD320326TEST001', fyLabel: '2026-27' }))
      .rejects.toThrow(/not registered for GST/i)
  })

  /**
   * 🔴 /tax/portal is deliberately NOT gstOnly — OLTAS challan status is the one statement
   * here an unregistered entity still uses. So the GST half is refused and the rest is not.
   */
  it('🔴 a GST electronic ledger to reconcile against', async () => {
    await expect(importPortalStatement(ctxB, {
      kind: 'GST_CASH_LEDGER', asOn: '2026-10-14', text: 'Central Tax,5000.00\nState/UT Tax,5000.00',
    })).rejects.toThrow(/not registered for GST/i)
  })

  it('but not the OLTAS challan status it does have a use for', async () => {
    const r = await importPortalStatement(ctxB, {
      kind: 'TDS_CHALLANS', asOn: '2026-10-14',
      text: '1,05103080709202602001,0510308,02001,07-09-2026,18000.00',
    })
    expect(r).toBeTruthy()
  })

  it('tells it what it does instead, not just what it cannot do', async () => {
    await expect(addLut(ctxB, { arn: 'AD320326TEST001', fyLabel: '2026-27' }))
      .rejects.toThrow(/bills of supply under rule 49/i)
  })
})

describe('🔴 a composition taxpayer has a GSTIN and still files neither return', () => {
  it('no GSTR-1, because it files GSTR-4', async () => {
    await expect(buildGstr1(ctxC.companyId, PERIOD.from, PERIOD.to, '2026-27'))
      .rejects.toThrow(/CMP-08 and GSTR-4/)
  })

  it('no GSTR-3B', async () => {
    await expect(buildGstr3b(ctxC.companyId, PERIOD.from, PERIOD.to, '2026-27'))
      .rejects.toThrow(/CMP-08 and GSTR-4/)
  })

  it('and it is not told it is unregistered, because it is not', async () => {
    await expect(buildGstr1(ctxC.companyId, PERIOD.from, PERIOD.to, '2026-27'))
      .rejects.toThrow(/pays tax under s\.10/)
  })
})

describe('🔴 the calendar stops inventing obligations', () => {
  it('names no GST return for an unregistered entity', async () => {
    const items = await complianceCalendar(ctxB, new Date('2026-10-31'))
    expect(items.filter((i) => i.obligation === 'GSTR1' || i.obligation === 'GSTR3B')).toEqual([])
  })

  it('names none for a composition taxpayer either, though it has a GSTIN', async () => {
    const items = await complianceCalendar(ctxC, new Date('2026-10-31'))
    expect(items.filter((i) => i.obligation === 'GSTR1' || i.obligation === 'GSTR3B')).toEqual([])
    const co = await prisma.company.findUniqueOrThrow({ where: { id: ctxC.companyId } })
    expect(co.gstin).toBeTruthy() // the old condition, which would have pushed both
  })

  /**
   * 🔴 An unregistered supplier's overseas client would otherwise be told to file Form
   * RFD-11 — which only a registered person can file — and that its export invoices are
   * blocked until it does.
   */
  it('🔴 does not ask an unregistered entity for a LUT it cannot file', async () => {
    await prisma.customer.create({ data: {
      companyId: ctxB.companyId, name: 'Overseas client of B', country: 'AE', stateCode: null,
      customerType: 'EXPORT', currency: 'USD', paymentTermDays: 15, billingAddress: {},
    } })
    const items = await complianceCalendar(ctxB, new Date('2026-10-31'))
    expect(items.filter((i) => i.obligation === 'LUT_RENEWAL')).toEqual([])
  })

  it('still names both returns for the entity that does file them', async () => {
    const items = await complianceCalendar(ctxA, new Date('2026-10-31'))
    expect(items.some((i) => i.obligation === 'GSTR1')).toBe(true)
    expect(items.some((i) => i.obligation === 'GSTR3B')).toBe(true)
  })
})

/**
 * 🔴 The invoice that could not be issued at all.
 *
 * `resolveLutForInvoice` keyed off the tax MODE, and an unregistered supplier billing abroad
 * resolves to EXPORT like anyone else. Send refused with LutMissing — telling entity B to file
 * Form RFD-11, which requires the registration it does not have. It had no way to bill a
 * foreign client, and the error named a remedy it could not perform.
 */
describe('🔴 an unregistered entity can bill abroad', () => {
  it('sends an overseas bill of supply with no LUT on file', async () => {
    const cust = await prisma.customer.create({ data: {
      companyId: ctxB.companyId, name: 'Dubai client', country: 'AE', stateCode: null,
      customerType: 'EXPORT', currency: 'USD', paymentTermDays: 30, billingAddress: {},
    } })
    const draft = await createInvoice(ctxB, { customerId: cust.id, date: '2026-10-02',
      lines: [{ description: 'Edit and grade', sacCode: '998314', quantity: '1', rate: '2000', gstRatePct: '0' }] })

    expect(draft.taxMode).toBe('EXPORT')
    expect(draft.docType).toBe('BILL_OF_SUPPLY')

    const luts = await prisma.companyLut.count({ where: { companyId: ctxB.companyId } })
    expect(luts).toBe(0)

    const sent = await sendInvoice(ctxB, draft.id)
    expect(sent.number).toMatch(/^UNRB\/26-27\/\d{4}$/)
    expect(sent.lutId).toBeNull()
  })

  it('and A still cannot, because its export really is zero-rated', async () => {
    const cust = await prisma.customer.create({ data: {
      companyId: ctxA.companyId, name: 'Overseas client of A', country: 'AE', stateCode: null,
      customerType: 'EXPORT', currency: 'USD', paymentTermDays: 30, billingAddress: {},
    } })
    const draft = await createInvoice(ctxA, { customerId: cust.id, date: '2026-10-02',
      lines: [{ description: 'Edit and grade', sacCode: '998314', quantity: '1', rate: '2000', gstRatePct: '0' }] })
    expect(draft.docType).toBe('EXPORT_INVOICE')
    await expect(sendInvoice(ctxA, draft.id)).rejects.toThrow(/Form RFD-11/)
  })
})

/**
 * The screens, swept from the nav rather than listed here.
 *
 * 🔴 `nav.ts` carries the `gstOnly` flag, so the set of GST-only screens is declared in one
 * place and this reads it. A new GST screen added to the rail with the flag and without the
 * guard fails here; one added without the flag is a leak this cannot see, which is why the
 * service-layer refusals above are the real gate.
 */
describe('every gstOnly screen refuses as well as hides', () => {
  const APP = join(process.cwd(), 'src', 'app', '(app)')
  const gstOnly = NAV.flatMap((g) => g.items).filter((i) => i.gstOnly)

  it('the sweep has something to sweep', () => {
    expect(gstOnly.length).toBeGreaterThanOrEqual(3)
  })

  it.each(gstOnly.map((i) => i.href))('%s calls requireGstRegistered', (href) => {
    const file = join(APP, href.replace(/^\//, ''), 'page.tsx')
    expect(existsSync(file), `${href} has no page.tsx`).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('requireGstRegistered')
  })
})
