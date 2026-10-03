import { describe, it, expect } from 'vitest'
import { parse2b, docKey } from '@/server/services/tax/gstr2b'

describe('🔴 the invoice number the two sides never spell the same way', () => {
  it('ignores case and punctuation', () => {
    expect(docKey('EX/300')).toBe('EX300')
    expect(docKey('ex-300')).toBe('EX300')
    expect(docKey(' EX 300 ')).toBe('EX300')
    expect(docKey('Ex.300')).toBe('EX300')
  })

  it('keeps the digits and letters that distinguish two invoices', () => {
    expect(docKey('EX/300')).not.toBe(docKey('EX/301'))
    expect(docKey('2026/EX/300')).not.toBe(docKey('EX/300'))
  })
})

const JSON_2B = JSON.stringify({
  data: {
    docdata: {
      b2b: [
        {
          ctin: '32AABCE1234F1Z5', trdnm: 'Exalture Software Lab',
          inv: [
            { inum: 'EX/300', idt: '10-06-2026', typ: 'R', val: 236000, itcavl: 'Y',
              items: [{ rt: 18, txval: 200000, cgst: 18000, sgst: 18000 }] },
            { inum: 'EX/301', idt: '20-06-2026', val: 11800, itcavl: 'N', rsn: 'POS and supplier state are the same',
              items: [{ rt: 18, txval: 10000, igst: 1800 }] },
          ],
        },
      ],
      b2ba: [
        { ctin: '29AABCB1234F1Z5', trdnm: 'Blink Digital',
          inv: [{ inum: 'BD/55', idt: '12-08-2026', itcavl: 'Y', items: [{ txval: 50000, igst: 9000 }] }] },
      ],
    },
  },
})

describe('reading the portal’s own JSON', () => {
  it('reads b2b invoices with their tax split', () => {
    const { rows } = parse2b(JSON_2B)
    const r = rows.find((x) => x.docNumber === 'EX/300')!
    expect(r.supplierGstin).toBe('32AABCE1234F1Z5')
    expect(r.supplierName).toBe('Exalture Software Lab')
    expect(r.taxableValue.toFixed(2)).toBe('200000.00')
    expect(r.cgst.toFixed(2)).toBe('18000.00')
    expect(r.sgst.toFixed(2)).toBe('18000.00')
    expect(r.igst.toFixed(2)).toBe('0.00')
    expect(r.docDate?.toISOString().slice(0, 10)).toBe('2026-06-10')
  })

  it('🔴 honours the portal’s own verdict that a credit is not available', () => {
    const { rows } = parse2b(JSON_2B)
    const r = rows.find((x) => x.docNumber === 'EX/301')!
    expect(r.itcAvailable).toBe(false)
    expect(r.itcReason).toMatch(/POS and supplier state/)
  })

  it('treats a missing itcavl as available, which is what the portal means by omitting it', () => {
    const { rows } = parse2b(JSON_2B)
    expect(rows.find((x) => x.docNumber === 'EX/300')!.itcAvailable).toBe(true)
  })

  it('includes amendments, which carry credit like any other row', () => {
    const { rows } = parse2b(JSON_2B)
    const r = rows.find((x) => x.docNumber === 'BD/55')!
    expect(r.docType).toBe('AMENDMENT')
    expect(r.igst.toFixed(2)).toBe('9000.00')
  })

  it('refuses JSON that is not a 2B, rather than reporting nothing found', () => {
    expect(() => parse2b('{"hello":"world"}')).toThrow(/no `docdata` section/)
    expect(() => parse2b('{not json')).toThrow(/not valid JSON/)
  })

  it('reports an invoice with no number instead of dropping it', () => {
    const { rows, skipped } = parse2b(JSON.stringify({
      docdata: { b2b: [{ ctin: '32AABCE1234F1Z5', inv: [{ idt: '01-06-2026', items: [{ igst: 100 }] }] }] },
    }))
    expect(rows).toEqual([])
    expect(skipped[0].reason).toMatch(/no number/)
  })
})

describe('reading a spreadsheet instead', () => {
  const SHEET = [
    'GSTIN of supplier,Trade name,Invoice number,Invoice date,Taxable value,Integrated tax,Central tax,State tax,ITC availability,Reason',
    '32AABCE1234F1Z5,Exalture Software Lab,EX/300,10-06-2026,200000,0,18000,18000,Yes,',
    '29AABCB1234F1Z5,Blink Digital,BD/55,12-08-2026,50000,9000,0,0,No,Return filed after the s.16(4) deadline',
  ].join('\n')

  it('takes the taxes from named columns', () => {
    const { rows } = parse2b(SHEET)
    const r = rows.find((x) => x.docNumber === 'EX/300')!
    expect(r.cgst.toFixed(2)).toBe('18000.00')
    expect(r.sgst.toFixed(2)).toBe('18000.00')
    expect(r.igst.toFixed(2)).toBe('0.00')
  })

  it('reads the availability column', () => {
    const { rows } = parse2b(SHEET)
    expect(rows.find((x) => x.docNumber === 'BD/55')!.itcAvailable).toBe(false)
  })

  it('🔴 refuses to guess which money column is which when there is no header', () => {
    // guessing is how a reconciliation compares the wrong figures and declares everything fine
    const { rows, skipped } = parse2b('32AABCE1234F1Z5,EX/300,10-06-2026,200000,0,18000,18000')
    expect(rows).toEqual([])
    expect(skipped[0].reason).toMatch(/No header row naming the tax columns/)
  })
})
