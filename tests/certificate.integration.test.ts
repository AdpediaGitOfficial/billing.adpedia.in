import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { resetDb } from './helpers/db'
import { createVendor } from '@/server/services/purchases/vendor'
import { createBill, approveBill } from '@/server/services/purchases/bill'
import { createChallan } from '@/server/services/tax/tds-challan'
import { recordTdsFiling } from '@/server/services/tax/tds-filing'
import {
  certificateRegister, recordCertificateDownload, recordCertificateIssued, certificatesOutstanding,
} from '@/server/services/tax/tds-certificate'
import { uploadAttachment } from '@/server/services/storage/attachment'
import { complianceCalendar } from '@/server/services/compliance/calendar'
import type { RequestContext } from '@/server/context'

const prisma = new PrismaClient()
let ctx: RequestContext, companyId = '', withPan = '', noPan = ''

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)])

beforeAll(async () => {
  await resetDb(prisma)
  const company = await prisma.company.findFirstOrThrow({ where: { pan: 'AAUCA9985H' } })
  const user = await prisma.user.findFirstOrThrow()
  ctx = { userId: user.id, companyId: company.id, role: 'OWNER' }
  companyId = company.id

  withPan = (await createVendor(ctx, {
    name: 'Exalture Software Lab', vendorType: 'SUBCONTRACTOR', country: 'IN', stateCode: '32',
    gstin: '32AABCE1234F1Z5', pan: 'AABCE1234F', defaultTdsSection: '194C',
  })).id
  noPan = (await createVendor(ctx, {
    name: 'Maneesh Unnikuttan', vendorType: 'FREELANCER', country: 'IN', stateCode: '32',
    defaultTdsSection: '194J',
  })).id

  for (const [vendorId, n, acct] of [[withPan, 'EX/700', '5220'], [noPan, 'MU/700', '5210']] as const) {
    await approveBill(ctx, (await createBill(ctx, {
      vendorId, billNumber: n, billDate: '2026-08-10',
      lines: [{ description: 'Work', sacCode: '998314', quantity: '1', rate: '200000', gstRatePct: '18', expenseAccountCode: acct }],
    })).id)
  }
})
afterAll(async () => { await prisma.$disconnect() })

describe('🔴 who is owed a certificate, derived from the deductions', () => {
  it('lists one per vendor per quarter, with its deadline', async () => {
    const reg = await certificateRegister(ctx)
    expect(reg.length).toBeGreaterThanOrEqual(2)

    const row = reg.find((r) => r.deducteeName.startsWith('Exalture'))!
    expect(row.formType).toBe('16A')
    expect(row.quarter).toBe(2)
    // 15 days after the Q2 return due date of 31 October
    expect(row.dueOn.toISOString().slice(0, 10)).toBe('2026-11-15')
    expect(row.issuedOn).toBeNull()
  })

  it('🔴 says a certificate cannot exist before the return is filed', async () => {
    const reg = await certificateRegister(ctx)
    const row = reg.find((r) => r.deducteeName.startsWith('Exalture'))!
    expect(row.returnFiled).toBe(false)
    expect(row.blockedBy).toMatch(/not recorded as filed/)

    await expect(recordCertificateDownload(ctx, {
      formType: '16A', quarter: 2, deducteeId: withPan, isEmployee: false, downloadedOn: '2026-11-10',
    })).rejects.toThrow(/TRACES generates the certificate from the statement/)
  })

  it('🔴 says a deductee with no PAN cannot have one at all', async () => {
    const reg = await certificateRegister(ctx)
    const row = reg.find((r) => r.deducteeName.startsWith('Maneesh'))!
    expect(row.pan).toBeNull()
    expect(row.blockedBy).toMatch(/No PAN/)
  })
})

describe('recording the real certificate', () => {
  let certId = ''

  it('accepts a download once the quarter is filed', async () => {
    // deposit and file, so TRACES would actually have something to generate from
    const deductions = await prisma.tdsDeduction.findMany({
      where: { companyId, quarter: 2, reversedAt: null, challanId: null, sectionCode: '194C' },
    })
    await createChallan(ctx, {
      sectionCode: '194C', quarter: 2, deductionIds: deductions.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '02001', depositedOn: '2026-09-07',
    })
    const j = await prisma.tdsDeduction.findMany({
      where: { companyId, quarter: 2, reversedAt: null, challanId: null, sectionCode: '194J' },
    })
    await createChallan(ctx, {
      sectionCode: '194J', quarter: 2, deductionIds: j.map((d) => d.id),
      bsrCode: '0510308', challanSerial: '02002', depositedOn: '2026-09-07',
    })
    await recordTdsFiling(ctx, { formType: '26Q', quarter: 2, filedOn: '2026-10-31' })

    const cert = await recordCertificateDownload(ctx, {
      formType: '16A', quarter: 2, deducteeId: withPan, isEmployee: false,
      tracesRequestNo: '98765432', downloadedOn: '2026-11-10',
    })
    certId = cert.id
    expect(cert.pan).toBe('AABCE1234F')
    expect(cert.downloadedOn).not.toBeNull()
  })

  it('🔴 refuses to record it as issued with no file on record', async () => {
    // "issued" with nothing attached is a claim nobody can check
    await expect(recordCertificateIssued(ctx, certId, '2026-11-12', 'accounts@exalture.example'))
      .rejects.toThrow(/Attach the certificate downloaded from TRACES first/)
  })

  it('accepts it once the downloaded file is attached', async () => {
    await uploadAttachment(ctx, {
      kind: 'TDS_CERTIFICATE', entityType: 'TdsCertificate', entityId: certId,
      filename: 'form16a-q2.pdf', contentType: 'application/pdf', bytes: PDF,
    })
    const saved = await recordCertificateIssued(ctx, certId, '2026-11-12', 'accounts@exalture.example')
    expect(saved.issuedOn).not.toBeNull()
    expect(saved.issuedTo).toBe('accounts@exalture.example')

    const reg = await certificateRegister(ctx)
    expect(reg.find((r) => r.deducteeName.startsWith('Exalture'))!.blockedBy).toBeNull()
  })

  it('refuses an issue date or recipient that says nothing', async () => {
    await expect(recordCertificateIssued(ctx, certId, 'not-a-date', 'someone@example.com'))
      .rejects.toThrow(/not a valid date/)
    await expect(recordCertificateIssued(ctx, certId, '2026-11-12', 'x'))
      .rejects.toThrow(/Say where it was sent/)
  })
})

describe('the compliance calendar', () => {
  it('🔴 counts what is still to issue, instead of asking for ever', async () => {
    const cal = await complianceCalendar(ctx)
    const item = cal.find((i) => i.id === 'form16a-q2')!
    expect(item.state).not.toBe('DONE')
    expect(item.detail).toMatch(/1 of 2 still to issue/)

    const counts = await certificatesOutstanding(ctx)
    expect(counts.byQuarter.get(2)).toEqual({ total: 2, issued: 1 })
  })

  it('marks Form 16 not applicable when nothing was deducted from salary', async () => {
    const cal = await complianceCalendar(ctx)
    const item = cal.find((i) => i.id === 'form16')!
    expect(item.state).toBe('NOT_APPLICABLE')
    expect(item.detail).toMatch(/nothing deducted yet/)
  })
})
