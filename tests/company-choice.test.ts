import { describe, it, expect } from 'vitest'
import { chooseCompany, type Membership } from '@/server/auth/company-choice'

const m = (companyId: string, legalName: string): Membership => ({
  companyId, role: 'OWNER', company: { legalName },
})

const ADPEDIA = m('c-adpedia', 'ADPEDIA FILMS PRIVATE LIMITED')
const SECOND = m('c-second', 'SECOND ENTITY')

describe('which entity a session opens — docs/82 §3', () => {
  it('none, when the account belongs to no company', () => {
    expect(chooseCompany([])).toBeNull()
  })

  it('the only one, whatever the preference says', () => {
    expect(chooseCompany([ADPEDIA], 'c-does-not-exist')?.companyId).toBe('c-adpedia')
  })

  it('the one the session was last in', () => {
    expect(chooseCompany([ADPEDIA, SECOND], 'c-second')?.companyId).toBe('c-second')
    expect(chooseCompany([ADPEDIA, SECOND], 'c-adpedia')?.companyId).toBe('c-adpedia')
  })

  /**
   * 🔴 docs/77 — access can be taken away. A stale preference must degrade to the fallback
   * rather than lock somebody out of an app they still have a company in.
   */
  it('falls back when the remembered entity is no longer a membership', () => {
    expect(chooseCompany([ADPEDIA], 'c-second')?.companyId).toBe('c-adpedia')
  })

  /**
   * 🔴 THE bug this replaces.
   *
   * `login` and the refresh path both read `user.companies[0]` from an include with no
   * `orderBy`. With one membership that is invisible; with two, the answer is whatever
   * Postgres returns first — and on a REFRESH it could change mid-session, moving which books
   * an invoice posts to. Same members, any order, same answer.
   */
  it('🔴 gives the same answer whatever order the rows arrive in', () => {
    const forwards = chooseCompany([ADPEDIA, SECOND])
    const backwards = chooseCompany([SECOND, ADPEDIA])
    expect(forwards?.companyId).toBe(backwards?.companyId)
    expect(forwards?.companyId).toBe('c-adpedia')   // by legal name
  })

  it('breaks a tie on name with the id, so even that is total', () => {
    const a = m('c-aaa', 'SAME NAME')
    const b = m('c-bbb', 'SAME NAME')
    expect(chooseCompany([a, b])?.companyId).toBe('c-aaa')
    expect(chooseCompany([b, a])?.companyId).toBe('c-aaa')
  })

  it('tolerates a membership whose company was not joined in', () => {
    const bare: Membership = { companyId: 'c-zzz', role: 'ACCOUNTANT' }
    expect(chooseCompany([bare])?.companyId).toBe('c-zzz')
    expect(chooseCompany([bare, ADPEDIA])?.companyId).toBe('c-adpedia')
  })
})
