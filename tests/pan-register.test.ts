import { describe, it, expect } from 'vitest'
import { parsePanPaste, matchByName, normaliseName } from '@/server/services/tax/pan-register'
import { panEntity, isCompanyOrFirm, isValidPanFormat } from '@/server/services/tax/pan'

describe('PAN format and entity type', () => {
  it('reads the entity from the 4th character', () => {
    expect(panEntity('ABCPE1234F')).toBe('INDIVIDUAL')
    expect(panEntity('AAUCA9985H')).toBe('COMPANY')     // Adpedia's own
    expect(panEntity('ABCFE1234F')).toBe('FIRM')
    expect(panEntity('ABCHE1234F')).toBe('HUF')
  })

  it('🔴 194C splits on that character, not on anything a human typed', () => {
    expect(isCompanyOrFirm('ABCPE1234F')).toBe(false)   // individual -> 1%
    expect(isCompanyOrFirm('AAUCA9985H')).toBe(true)    // company    -> 2%
    expect(isCompanyOrFirm('ABCFE1234F')).toBe(true)    // firm/LLP   -> 2%
  })

  it('rejects malformed PANs', () => {
    for (const bad of ['ABCDE123F', 'ABCD1234F', 'ABCDE12345', '12345ABCDF', '', 'NOTAPAN']) {
      expect(isValidPanFormat(bad)).toBe(false)
    }
  })

  it('🔴 accepts a well-formed PAN that may not exist — format is not evidence', () => {
    // nothing available here can say whether a PAN exists and whose it is, which is why
    // docs/47 keeps `panEvidence` alongside the number: the card copy is what the company
    // holds, and a wrong-but-well-formed number surfaces on TRACES, not in this check
    expect(isValidPanFormat('ABCDE1234F')).toBe(true)
  })
})

describe('pasting a list of PANs', () => {
  it('reads "Name, PAN" from a spreadsheet copy', () => {
    const rows = parsePanPaste(`
      Akash Raveendran, ABCPE1234F
      Deepak Damodaran, BXYPK5678L
    `)
    expect(rows).toEqual([
      { name: 'Akash Raveendran', pan: 'ABCPE1234F' },
      { name: 'Deepak Damodaran', pan: 'BXYPK5678L' },
    ])
  })

  it('reads tab-separated and pipe-separated just as happily', () => {
    expect(parsePanPaste('Kiran N S\tABCPE1234F')).toEqual([{ name: 'Kiran N S', pan: 'ABCPE1234F' }])
    expect(parsePanPaste('Kiran N S | ABCPE1234F')).toEqual([{ name: 'Kiran N S', pan: 'ABCPE1234F' }])
  })

  it('reads the PAN first and the name second', () => {
    expect(parsePanPaste('ABCPE1234F  Akash Raveendran'))
      .toEqual([{ name: 'Akash Raveendran', pan: 'ABCPE1234F' }])
  })

  it('uppercases a lowercase PAN', () => {
    expect(parsePanPaste('Akash, abcpe1234f')[0].pan).toBe('ABCPE1234F')
  })

  it('skips lines with no PAN rather than guessing', () => {
    expect(parsePanPaste('Akash Raveendran\nPending — will send tomorrow\n')).toEqual([])
  })

  it('ignores blank lines and headers', () => {
    const rows = parsePanPaste('\nName, PAN\n\nAkash, ABCPE1234F\n\n')
    expect(rows).toEqual([{ name: 'Akash', pan: 'ABCPE1234F' }])
  })
})

describe('matching pasted names to people on file', () => {
  const people = [
    { id: 'e1', name: 'Akash Raveendran' },
    { id: 'e2', name: 'Kiran N S' },
    { id: 'e3', name: 'Deepak Damodaran' },
  ]

  it('matches exactly', () => {
    const { matched } = matchByName([{ name: 'Akash Raveendran', pan: 'ABCPE1234F' }], people)
    expect(matched[0].person.id).toBe('e1')
  })

  it('🔴 matches through punctuation and spacing differences', () => {
    // "Kiran N.S." on a CA's spreadsheet is "Kiran N S" here; a strict match would send
    // the person back to retype a list they already have
    const { matched } = matchByName([{ name: 'Kiran N.S.', pan: 'ABCPE1234F' }], people)
    expect(matched[0].person.id).toBe('e2')
  })

  it('reports what it could not place instead of attaching it to the wrong person', () => {
    const { matched, unmatched } = matchByName(
      [{ name: 'Someone Else', pan: 'ABCPE1234F' }], people)
    expect(matched).toHaveLength(0)
    expect(unmatched).toEqual([{ name: 'Someone Else', pan: 'ABCPE1234F' }])
  })

  it('normalises names consistently', () => {
    expect(normaliseName('Kiran N.S.')).toBe(normaliseName('Kiran N S'))
    expect(normaliseName('DEEPAK  Damodaran')).toBe(normaliseName('deepak damodaran'))
  })
})
