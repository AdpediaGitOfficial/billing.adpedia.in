import { describe, it, expect } from 'vitest'
import { docTypeFor, isGstRegistered, mayCollectTax, assertMayChargeGst, carriesTax } from '@/server/services/invoicing/document-type'
import { navFor } from '@/components/shell/nav'
import type { GstRegType, TaxMode } from '@prisma/client'

const MODES: TaxMode[] = ['INTRA', 'INTER', 'EXPORT', 'SEZ_WITHOUT_PAY', 'SEZ_WITH_PAY']

describe('which document an entity may issue — docs/82 §5, rule 49', () => {
  it('a regular registered person issues a tax invoice, or an export invoice', () => {
    expect(docTypeFor('REGULAR', 'INTRA')).toBe('TAX_INVOICE')
    expect(docTypeFor('REGULAR', 'INTER')).toBe('TAX_INVOICE')
    expect(docTypeFor('REGULAR', 'EXPORT')).toBe('EXPORT_INVOICE')
  })

  it('🔴 an unregistered person issues a bill of supply, whatever the supply is', () => {
    for (const mode of MODES) expect(docTypeFor('UNREGISTERED', mode)).toBe('BILL_OF_SUPPLY')
  })

  /**
   * 🔴 The case that is easy to get wrong, because a composition dealer IS registered.
   *
   * Rule 49 names it alongside the unregistered: a registered person paying tax under s.10
   * issues a bill of supply, because s.10(4) forbids collecting tax from the customer. Keyed
   * off "is registered" alone it would get a tax invoice and be invited to charge tax it must
   * absorb out of its own margin.
   */
  it('🔴 so does a composition taxpayer, which is registered all the same', () => {
    for (const mode of MODES) expect(docTypeFor('COMPOSITION', mode)).toBe('BILL_OF_SUPPLY')
    expect(isGstRegistered('COMPOSITION')).toBe(true)      // it files
    expect(mayCollectTax('COMPOSITION')).toBe(false)       // it may not collect
  })

  it('an export is only zero-rated for somebody who may collect tax at all', () => {
    expect(docTypeFor('UNREGISTERED', 'EXPORT')).not.toBe('EXPORT_INVOICE')
  })

  it('a bill of supply carries no tax', () => {
    expect(carriesTax('BILL_OF_SUPPLY')).toBe(false)
    expect(carriesTax('TAX_INVOICE')).toBe(true)
    expect(carriesTax('EXPORT_INVOICE')).toBe(true)
  })
})

describe('charging tax without the right to', () => {
  const lines = (rate: string) => [{ gstRatePct: rate }]

  it('is refused for an unregistered entity, citing s.32(1)', () => {
    expect(() => assertMayChargeGst('UNREGISTERED', lines('18'))).toThrow(/s\.32\(1\)/)
  })

  it('is refused for a composition taxpayer, citing s.10(4)', () => {
    expect(() => assertMayChargeGst('COMPOSITION', lines('18'))).toThrow(/s\.10\(4\)/)
  })

  it('allows nil, which is what those entities actually bill at', () => {
    for (const reg of ['UNREGISTERED', 'COMPOSITION'] as GstRegType[]) {
      expect(() => assertMayChargeGst(reg, lines('0'))).not.toThrow()
      expect(() => assertMayChargeGst(reg, [{ gstRatePct: null }])).not.toThrow()
      expect(() => assertMayChargeGst(reg, [{}])).not.toThrow()
    }
  })

  it('never stands in the way of a regular registered person', () => {
    expect(() => assertMayChargeGst('REGULAR', lines('18'))).not.toThrow()
  })
})

describe('the screens an unregistered entity is offered', () => {
  const hrefs = (gstRegistered: boolean) =>
    navFor('OWNER', { gstRegistered }).flatMap((g) => g.items.map((i) => i.href))

  it('🔴 hides GST, the LUT register and e-invoicing', () => {
    const hidden = hrefs(false)
    for (const href of ['/tax/gst', '/settings/lut', '/settings/e-invoice']) {
      expect(hrefs(true), `${href} should exist for a registered entity`).toContain(href)
      expect(hidden, `${href} must not be offered to an unregistered entity`).not.toContain(href)
    }
  })

  /**
   * TDS is income tax. An unregistered entity still deducts it, still has it deducted, and
   * still has a PAN register and a compliance calendar — hiding those would be a different bug.
   */
  it('keeps everything that is not about GST', () => {
    const hidden = hrefs(false)
    for (const href of ['/tax/tds', '/tax/tds-receivable', '/tax/pan', '/tax/calendar', '/invoices']) {
      expect(hidden).toContain(href)
    }
  })

  it('defaults to showing them, so nothing disappears for a registered entity', () => {
    expect(navFor('OWNER').flatMap((g) => g.items.map((i) => i.href))).toContain('/tax/gst')
  })
})
