import { describe, it, expect } from 'vitest'
import { Decimal, ZERO } from '@/lib/money'
import {
  validateEInvoice, buildEInvoicePayload, supplyTypeFor,
  type EInvoiceInput, type EInvoiceLine,
} from '@/server/services/einvoice/payload'
import { canCancel, cancellableUntil, MockIrpAdapter } from '@/server/services/einvoice/adapter'

const D = (v: string) => new Decimal(v)

const seller = {
  gstin: '32AAUCA9985H1ZX', legalName: 'ADPEDIA FILMS PRIVATE LIMITED',
  address1: 'VIII/318, Chinnangath House', location: 'Chalakudy',
  pincode: '680307', stateCode: '32',
}
const buyer = {
  gstin: '32AAKCC9890P1ZS', legalName: 'CLICK AR BUSINESS PRIVATE LIMITED',
  address1: 'Kakkanad', location: 'Ernakulam', pincode: '682030', stateCode: '32',
}

function line(over: Partial<EInvoiceLine> = {}): EInvoiceLine {
  return {
    slNo: 1, description: 'Staff augmentation', isService: true, hsnOrSac: '998314',
    quantity: D('1'), unit: 'OTH', unitPrice: D('100000'),
    taxableValue: D('100000'), gstRatePct: D('18'),
    cgst: D('9000'), sgst: D('9000'), igst: ZERO, total: D('118000'),
    ...over,
  }
}

function invoice(over: Partial<EInvoiceInput> = {}): EInvoiceInput {
  const lines = over.lines ?? [line()]
  return {
    docType: 'INV', number: 'ADP/26-27/0026', date: new Date(Date.UTC(2026, 8, 30)),
    taxMode: 'INTRA', seller, buyer, lines,
    taxableValue: D('100000'), cgst: D('9000'), sgst: D('9000'), igst: ZERO,
    grandTotal: D('118000'), currency: 'INR',
    ...over,
  }
}

describe('a clean intra-state invoice', () => {
  it('passes validation', () => {
    expect(validateEInvoice(invoice())).toEqual([])
  })

  it('builds a schema 1.1 payload the IRP would accept', () => {
    const p = buildEInvoicePayload(invoice()) as Record<string, Record<string, unknown>>
    expect(p.Version).toBe('1.1')
    expect(p.TranDtls.SupTyp).toBe('B2B')
    expect(p.TranDtls.TaxSch).toBe('GST')
    expect(p.DocDtls.No).toBe('ADP/26-27/0026')
    expect(p.SellerDtls.Pin).toBe(680307)       // number, not a string
    expect(p.ValDtls.TotInvVal).toBe(118000)
  })

  it('🔴 writes the date as dd/mm/yyyy, the only format the IRP takes', () => {
    const p = buildEInvoicePayload(invoice()) as Record<string, Record<string, unknown>>
    expect(p.DocDtls.Dt).toBe('30/09/2026')     // not 2026-09-30, not 09/30/2026
  })
})

describe('🔴 document number rules', () => {
  it('rejects a number over 16 characters', () => {
    const issues = validateEInvoice(invoice({ number: 'ADP/EXP/26-27/0004' }))
    expect(issues.some((i) => i.field === 'DocDtls.No')).toBe(true)
  })

  it('rejects a number starting with 0, / or -', () => {
    for (const n of ['0ADP/26/1', '/ADP/26/1', '-ADP/26/1']) {
      expect(validateEInvoice(invoice({ number: n })).some((i) => i.field === 'DocDtls.No')).toBe(true)
    }
  })

  it('accepts the series actually in use', () => {
    for (const n of ['ADP/26-27/0026', 'ADPX/26-27/0001', 'ADPC/26-27/0001']) {
      expect(validateEInvoice(invoice({ number: n }))).toEqual([])
    }
  })
})

describe('🔴 the tax split must match the supply type', () => {
  it('refuses IGST on an intra-state supply', () => {
    const issues = validateEInvoice(invoice({
      lines: [line({ cgst: ZERO, sgst: ZERO, igst: D('18000') })],
      cgst: ZERO, sgst: ZERO, igst: D('18000'),
    }))
    expect(issues.some((i) => i.field === 'ValDtls.IgstVal')).toBe(true)
  })

  it('refuses CGST/SGST on an inter-state supply', () => {
    const issues = validateEInvoice(invoice({ taxMode: 'INTER' }))
    expect(issues.some((i) => i.field === 'ValDtls.CgstVal')).toBe(true)
  })

  it('refuses any tax on an export under LUT', () => {
    const issues = validateEInvoice(invoice({
      taxMode: 'EXPORT', exportWithPayment: false, countryCode: 'US',
      buyer: { ...buyer, gstin: null },
    }))
    expect(issues.some((i) => i.field === 'ValDtls')).toBe(true)
  })
})

describe('exports', () => {
  const exportInvoice = () => invoice({
    taxMode: 'EXPORT', exportWithPayment: false, countryCode: 'US', currency: 'USD',
    buyer: { ...buyer, gstin: null, stateCode: null, pincode: null },
    // an export under LUT is zero-RATED, so the rate itself is 0 — not 18% with the tax
    // left off, which is what the validator rightly refuses
    lines: [line({ gstRatePct: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, total: D('100000') })],
    cgst: ZERO, sgst: ZERO, igst: ZERO, grandTotal: D('100000'),
  })

  it('passes with no tax and a country code', () => {
    expect(validateEInvoice(exportInvoice())).toEqual([])
  })

  it('🔴 sends URP, PIN 999999 and state 96 for an overseas buyer', () => {
    // sending the seller's own state here is the classic export rejection
    const p = buildEInvoicePayload(exportInvoice()) as Record<string, Record<string, unknown>>
    expect(p.BuyerDtls.Gstin).toBe('URP')
    expect(p.BuyerDtls.Pin).toBe(999999)
    expect(p.BuyerDtls.Stcd).toBe('96')
    expect(p.BuyerDtls.Pos).toBe('96')
  })

  it('marks it EXPWOP under LUT and EXPWP with payment', () => {
    expect(supplyTypeFor(exportInvoice())).toBe('EXPWOP')
    expect(supplyTypeFor({ ...exportInvoice(), exportWithPayment: true })).toBe('EXPWP')
  })

  it('needs a country code', () => {
    const issues = validateEInvoice({ ...exportInvoice(), countryCode: null })
    expect(issues.some((i) => i.field === 'ExpDtls.CntCode')).toBe(true)
  })
})

describe('🔴 arithmetic the IRP cross-checks', () => {
  it('catches a line that does not add up', () => {
    const issues = validateEInvoice(invoice({ lines: [line({ total: D('99999') })] }))
    expect(issues.some((i) => i.field.endsWith('.TotItemVal'))).toBe(true)
  })

  it('catches tax that does not match the rate claimed', () => {
    const issues = validateEInvoice(invoice({
      lines: [line({ gstRatePct: D('5'), cgst: D('9000'), sgst: D('9000') })],
    }))
    expect(issues.some((i) => i.field.endsWith('.GstRt'))).toBe(true)
  })

  it('catches a header total that disagrees with the lines', () => {
    const issues = validateEInvoice(invoice({ grandTotal: D('200000') }))
    expect(issues.some((i) => i.field === 'ValDtls.TotInvVal')).toBe(true)
  })

  it('tolerates rounding of up to a rupee, as the IRP does', () => {
    expect(validateEInvoice(invoice({ grandTotal: D('118000.50') }))).toEqual([])
  })
})

describe('master data the IRP insists on', () => {
  it('🔴 refuses a B2B invoice with no buyer GSTIN — B2C is not eligible at all', () => {
    const issues = validateEInvoice(invoice({ buyer: { ...buyer, gstin: null } }))
    expect(issues.some((i) => i.field === 'BuyerDtls.Gstin')).toBe(true)
    expect(issues[0].message).toMatch(/B2C/)
  })

  it('refuses a line with no HSN/SAC', () => {
    const issues = validateEInvoice(invoice({ lines: [line({ hsnOrSac: null })] }))
    expect(issues.some((i) => i.field.endsWith('.HsnCd'))).toBe(true)
  })

  it('refuses an HSN/SAC that is not 4–8 digits', () => {
    const issues = validateEInvoice(invoice({ lines: [line({ hsnOrSac: '99' })] }))
    expect(issues.some((i) => i.field.endsWith('.HsnCd'))).toBe(true)
  })

  it('refuses a PIN code that is not six digits', () => {
    const issues = validateEInvoice(invoice({ buyer: { ...buyer, pincode: '6820' } }))
    expect(issues.some((i) => i.field === 'BuyerDtls.Pin')).toBe(true)
  })
})

describe('🔴 the 24-hour cancellation window', () => {
  const ack = new Date('2026-09-30T10:00:00Z')

  it('allows cancellation inside the window', () => {
    expect(canCancel(ack, new Date('2026-09-30T23:59:00Z'))).toBe(true)
  })

  it('refuses a minute after, with no grace', () => {
    expect(canCancel(ack, new Date('2026-10-01T10:01:00Z'))).toBe(false)
  })

  it('reports exactly when the window closes', () => {
    expect(cancellableUntil(ack).toISOString()).toBe('2026-10-01T10:00:00.000Z')
  })
})

describe('the mock adapter', () => {
  it('names itself conspicuously so its IRN is never mistaken for a real one', async () => {
    expect(new MockIrpAdapter().name).toMatch(/not a real/i)
  })

  it('returns a 64-character IRN, deterministic for the same document', async () => {
    const a = new MockIrpAdapter()
    const p = buildEInvoicePayload(invoice())
    const first = await a.generate(p)
    const again = await a.generate(p)
    expect(first.irn).toHaveLength(64)
    expect(first.irn).toBe(again.irn)
  })
})
