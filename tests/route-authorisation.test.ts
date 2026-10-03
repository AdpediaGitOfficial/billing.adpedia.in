import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const API = join(process.cwd(), 'src', 'app', 'api')

function routes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) routes(p, out)
    else if (e === 'route.ts') out.push(p)
  }
  return out
}

const rel = (p: string) => p.slice(join(process.cwd(), 'src').length + 1).replace(/\\/g, '/')

/**
 * 🔴 docs/57 — every API route must say who may call it.
 *
 * Five of them did not. `requireContext()` proves only that the caller is signed in to this
 * company, and the four routes that rendered or previewed a document went straight from
 * there to the data: an EMPLOYEE, who holds `expenses.own` and `payroll.own` and nothing
 * else, could download every invoice and credit note by walking the ids.
 *
 * It was invisible because the services those routes called take a `companyId` rather than a
 * context, so there was no missing argument and nothing to notice. A grep is the only thing
 * that finds it, so the grep is a test.
 */
const ALLOWED_WITHOUT_A_CHECK: Record<string, string> = {
  'app/api/auth/login/route.ts': 'signs the caller in — there is no context yet',
  'app/api/auth/logout/route.ts': 'ends a session; needs no capability',
  'app/api/auth/refresh/route.ts': 'exchanges a refresh token before a context exists',
  'app/api/auth/me/route.ts': 'returns only the caller’s own identity',
  'app/api/auth/webauthn/register/route.ts': 'enrols a passkey for the caller themselves',
  'app/api/auth/webauthn/authenticate/route.ts': 'runs before authentication completes',
  'app/api/push/subscribe/route.ts': 'stores the caller’s own push subscription',
  'app/api/attachments/route.ts': 'uploadAttachment asserts expenses.own internally',
  'app/api/attachments/[id]/route.ts': 'readAttachment and detachAttachment assert internally',
  'app/api/expenses/route.ts': 'createExpense asserts expenses.own internally',
}

describe('🔴 every API route says who may call it', () => {
  const found = routes(API).map(rel)

  it('finds the routes at all', () => {
    expect(found.length).toBeGreaterThan(10)
  })

  for (const r of routes(API)) {
    const name = rel(r)
    it(`${name} is authorised or deliberately exempt`, () => {
      const src = readFileSync(r, 'utf8')
      const checks = /assertCan\(|assertMayRead|assertNotReadOnly\(/.test(src)
      if (checks) return
      expect(
        ALLOWED_WITHOUT_A_CHECK[name],
        `${name} has no authorisation check. Add one, or list it in ALLOWED_WITHOUT_A_CHECK ` +
        'with the reason it does not need one.',
      ).toBeTruthy()
    })
  }

  it('does not carry exemptions for routes that no longer exist', () => {
    for (const listed of Object.keys(ALLOWED_WITHOUT_A_CHECK)) {
      expect(found, `${listed} is exempted and does not exist`).toContain(listed)
    }
  })

  it('🔴 does not exempt anything that renders a document', () => {
    for (const listed of Object.keys(ALLOWED_WITHOUT_A_CHECK)) {
      expect(listed).not.toMatch(/document/)
    }
  })
})
