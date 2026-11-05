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
  // 🔴 docs/60 — the only route with no signed-in user at all. It carries its own shared
  // secret and REFUSES when CRON_SECRET is unset, rather than running open.
  'app/api/cron/notify/route.ts': 'scheduler endpoint; authenticated by CRON_SECRET, disabled without one',
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

  it('🔴 the exempt scheduler route checks a secret of its own', () => {
    const src = readFileSync(join(API, 'cron', 'notify', 'route.ts'), 'utf8')
    expect(src).toMatch(/CRON_SECRET/)
    // and refuses rather than running open when it is not configured
    expect(src).toMatch(/is not set, so this endpoint is disabled/)
    expect(src).toMatch(/timingSafeEqual/)
  })
})

/**
 * 🔴 docs/83 — a route that moves the session has to have a caller.
 *
 * `/api/auth/refresh` was complete: rotating tokens, reuse detection, a thirty-day lifetime.
 * Nothing in the application ever called it. So the access cookie — `maxAge:
 * ACCESS_TOKEN_TTL_SECONDS` — expired fifteen minutes after signing in, the middleware saw no
 * token and redirected to `/login`, mid-task, with nothing recording that anything had
 * happened. docs/80's defect class, with the session as the thing it cost.
 *
 * Scoped to the routes that import `@/server/auth/service` — the module that sets and clears
 * the auth cookies — which is a rule rather than a list:
 * `/api/auth/me` reads and is a diagnostic with no in-app caller (docs/20), and the cron route
 * is called by cron. A route that hands out a session and has no caller is dead in a way that
 * is felt rather than noticed.
 */
describe('🔴 every route that issues a session is actually called', () => {
  const SRC = join(process.cwd(), 'src')

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) sources(p, out)
      else if (/\.(ts|tsx)$/.test(e) && !p.startsWith(API)) out.push(p)
    }
    return out
  }

  const BODY = sources(SRC).map((f) => readFileSync(f, 'utf8')).join('\n')

  it('finds a caller for each of them', () => {
    const orphans: string[] = []
    for (const file of routes(API)) {
      const src = readFileSync(file, 'utf8')
      // the session lives in cookies the SERVICE sets, so what marks a session route is
      // importing it — `login`, `logout` and `refresh` are the three that do
      if (!src.includes("@/server/auth/service")) continue
      const href = '/api/' + file.slice(API.length + 1).replace(/[/\\]route\.ts$/, '').split(/[/\\]/).join('/')
      if (!BODY.includes(href)) orphans.push(href)
    }
    expect(orphans, 'a route that hands out a session and nothing calls').toEqual([])
  })

  it('is not vacuous — it found the session routes to check', () => {
    const checked = routes(API).filter((f) =>
      readFileSync(f, 'utf8').includes("@/server/auth/service"))
    expect(checked.length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * 🔴 docs/86 — the same rule, for SERVER ACTIONS, where nothing was checking at all.
 *
 * The sweep above covers `src/app/api`. Every mutation a screen performs goes through a
 * server action instead, and an action is a POST endpoint with a generated name: anyone with
 * a session can call it. Almost all of them delegate to a service that begins with
 * `assertCan`, which is why this was never felt — but `skipTxnAction` reached `prisma`
 * directly, so a signed-in session was the whole of the check. An AUDITOR, who holds
 * `banking` at `read` precisely so the books cannot be touched, could mark a bank line
 * IGNORED; so could an EMPLOYEE, who has no banking capability at all. An ignored line leaves
 * the reconciliation queue for good, so money that arrived is never matched and the client is
 * chased for it.
 *
 * The rule is narrow on purpose: an action that writes through `prisma` ITSELF must assert,
 * because there is no service underneath it to do so. An action that calls a service is left
 * alone — the service's own `assertCan` is the check, and the API sweep's reasoning applies.
 */
describe('🔴 every server action that writes says who may call it', () => {
  const APP = join(process.cwd(), 'src', 'app')

  function actionFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) actionFiles(p, out)
      else if (/^actions\.tsx?$/.test(e)) out.push(p)
    }
    return out
  }

  /** the exported function bodies of one module, by brace balance */
  function exported(src: string): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = []
    for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
      const open = src.indexOf('{', m.index! + m[0].length - 1)
      let depth = 0, end = src.length
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) { end = i; break }
      }
      out.push({ name: m[1], body: src.slice(open, end) })
    }
    return out
  }

  const WRITES = /prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/

  const files = actionFiles(APP).filter((f) => /['"]use server['"]/.test(readFileSync(f, 'utf8')))

  it('is not vacuous — it found the action modules', () => {
    expect(files.length).toBeGreaterThan(15)
    const total = files.reduce((a, f) => a + exported(readFileSync(f, 'utf8')).length, 0)
    expect(total).toBeGreaterThan(50)
  })

  it('finds the actions that write through prisma themselves', () => {
    const writers = files.flatMap((f) =>
      exported(readFileSync(f, 'utf8')).filter((a) => WRITES.test(a.body)).map((a) => `${rel(f)} ${a.name}`))
    // 🔴 if this ever drops to zero the next test proves nothing
    expect(writers.length).toBeGreaterThanOrEqual(2)
  })

  it('each of them asserts a capability', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const a of exported(readFileSync(f, 'utf8'))) {
        if (!WRITES.test(a.body)) continue
        if (!/assertCan\(/.test(a.body)) offenders.push(`${rel(f)} ${a.name}`)
      }
    }
    expect(
      offenders,
      'a server action writing straight to the database with no capability check — '
      + 'add assertCan, or route the write through a service that has one',
    ).toEqual([])
  })
})
