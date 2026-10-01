import { describe, it, expect } from 'vitest'
import { lookupSac, validateSac, sacLooksWrongForDescription, SAC_CODES } from '@/server/services/invoicing/sac'

describe('the SAC catalogue', () => {
  it('🔴 puts film production on 999612, not an IT code', () => {
    const film = lookupSac('999612')!
    expect(film.title).toMatch(/Motion picture/i)
    expect(film.gstRatePct).toBe(18)
  })

  it('separates production from post-production', () => {
    expect(lookupSac('999612')!.use).toMatch(/brand film|ad film|TVC/i)
    expect(lookupSac('999613')!.title).toMatch(/post-production/i)
  })

  it('has no duplicate codes, and every code is a chapter 99 service', () => {
    const codes = SAC_CODES.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) expect(c).toMatch(/^99\d{4}$/)
  })

  it('every service is 18% — none of these fall in a lower slab', () => {
    for (const s of SAC_CODES) expect(s.gstRatePct).toBe(18)
  })
})

describe('validating a SAC before it reaches an invoice', () => {
  it('requires one at all', () => {
    expect(validateSac(null)[0].level).toBe('error')
    expect(validateSac(null)[0].message).toMatch(/GSTR-1/)
  })

  it('rejects the wrong shape', () => {
    expect(validateSac('99831')[0].message).toMatch(/is 5 digits/)
    expect(validateSac('9983145')[0].message).toMatch(/is 7 digits/)
    expect(validateSac('abc123')[0].message).toMatch(/not numeric/)
  })

  it('🔴 rejects a goods HSN used where a service code belongs', () => {
    // 8471 is "automatic data processing machines" — a real HSN, wrong kind of code
    const issues = validateSac('847130')
    expect(issues[0].level).toBe('error')
    expect(issues[0].message).toMatch(/chapter 99/)
  })

  it('warns, rather than refuses, on a well-formed code it does not know', () => {
    // the catalogue covers what Adpedia sells today; refusing a legitimate code the system
    // has simply not heard of would be overruling the person who billed the work
    const issues = validateSac('998399')
    expect(issues).toHaveLength(1)
    expect(issues[0].level).toBe('warn')
  })

  it('🔴 flags the staff-augmentation judgement call instead of pretending it is settled', () => {
    const issues = validateSac('998513')
    expect(issues[0].level).toBe('warn')
    expect(issues[0].message).toMatch(/who directs the work/)
    // and says why the residual bucket is the weaker choice
    expect(validateSac('998519')[0].message).toMatch(/residual/)
  })

  it('passes a settled code silently', () => {
    expect(validateSac('999612')).toEqual([])
    expect(validateSac('998314')).toEqual([])
  })
})

describe('🔴 catching film work billed under an IT code', () => {
  it('flags the exact mistake that was in the demo data', () => {
    const issue = sacLooksWrongForDescription('Brand film — milestone 1', '998314')
    expect(issue).toBeTruthy()
    expect(issue!.message).toMatch(/999612/)
  })

  it('catches post-production work too', () => {
    // plurals included on purpose: \b(film)\b does not match "films"
    for (const d of ['Motion graphics package', 'Colour grade and VFX', 'Voice-over recording',
                     'Edit of the TVC', 'Two brand films', 'Product videos']) {
      expect(sacLooksWrongForDescription(d, '998391')).toBeTruthy()
    }
  })

  it('stays quiet when the code already matches the work', () => {
    expect(sacLooksWrongForDescription('Brand film — milestone 1', '999612')).toBeNull()
    expect(sacLooksWrongForDescription('Motion graphics package', '999613')).toBeNull()
  })

  it('does not fire on work that genuinely is IT or design', () => {
    expect(sacLooksWrongForDescription('Staff augmentation — developer', '998314')).toBeNull()
    expect(sacLooksWrongForDescription('UI/UX design revisions', '998391')).toBeNull()
  })
})
